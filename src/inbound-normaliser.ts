import type { Attachment, InboundEvent, SenderProfile } from '@swarmai/plugin-sdk';
import type { BaileysWAMessage, BaileysMessageContent } from './types.js';

/**
 * Normalise a Baileys `WAMessage` into the SDK's `InboundEvent` shape.
 *
 * Baileys' message types are deeply nested (see protobuf-derived
 * `proto.IWebMessageInfo`). We only consume the message variants the
 * agent can actually act on:
 *   - text (conversation / extendedTextMessage)
 *   - image / video / audio (with optional caption)
 *   - document (with filename)
 *   - sticker (treated as image)
 *   - reaction (placeholder body)
 *
 * Unknown / unhandled types fall through with a `[whatsapp-personal:<type>]`
 * placeholder, mirroring the Cloud variant's behaviour so downstream
 * agents see consistent placeholders regardless of mode.
 *
 * Phase 10A — group / @-mention detection. When the bot's own JID
 * appears in `extendedTextMessage.contextInfo.mentionedJid` (or its
 * digits-only form anywhere in the message body), `flags.mentioned`
 * is set true. Group messages additionally set `flags.groupChat` so
 * the channel-bridge can treat them differently from DMs.
 */

export interface NormaliseOptions {
  /**
   * Bot's own JID (from `socket.user.id`) — used to detect @-mentions
   * of the operator's own number in group messages. Optional; when
   * unset, mention detection is skipped (the message still flows
   * through as a normal inbound event).
   */
  selfJid?: string;
  /**
   * Bot's display name (operator-set). When the message body contains
   * a leading `@<displayName>` mention (case-insensitive), the
   * mentioned flag is set even without a JID match. Useful for
   * groups where users type the friendly name instead of the number.
   */
  selfDisplayName?: string;
}

export function normaliseBaileysMessage(
  channelId: string,
  msg: BaileysWAMessage,
  opts: NormaliseOptions = {},
): InboundEvent | null {
  if (!msg?.message || !msg.key) return null;
  if (msg.key.fromMe) return null;

  const from = readSenderId(msg);
  if (!from) return null;

  const { body, attachments, type, decoded } = decodeContent(msg.message);

  const ts = readTimestamp(msg.messageTimestamp);

  // Phase 10A — detect group thread + bot mention.
  const isGroup = isGroupRemoteJid(msg.key.remoteJid);
  const mentioned = detectMention(msg, body, opts);

  // A12 — group flags shape parity with channel-telegram. `groupChat`
  // and `chatType` ('private' | 'group') feed the channel-bridge's
  // group-policy gate. `groupId` (the @g.us-suffixed JID) is the
  // stable per-group identifier the operator approves.
  const flags: Record<string, boolean | string | number> = {
    chatType: isGroup ? 'group' : 'private',
  };
  if (isGroup) {
    flags['groupChat'] = true;
    if (msg.key.remoteJid) flags['groupId'] = msg.key.remoteJid;
  }
  if (mentioned) flags['mentioned'] = true;

  // 2026-05-17 — identity surfacing. WhatsApp messages carry pushName
  // (the contact's display name as they set it on their phone) and a
  // JID (the transport id). Two JID shapes are possible:
  //   - `<phone>@s.whatsapp.net`  → phone derivable from prefix
  //   - `<random_id>@lid`         → WhatsApp Privacy ID (newer accounts);
  //                                  phone NOT in the JID, needs a
  //                                  separate Baileys lookup we don't
  //                                  block inbound on. phoneNumber stays
  //                                  undefined; rawId preserves the LID
  //                                  so the operator can still identify
  //                                  the contact (it's stable per-user).
  const profile = buildWhatsAppSenderProfile(msg);

  return {
    channelId,
    from,
    // Only fall back to a placeholder when we couldn't decode the
    // message at all. Successfully-decoded messages with no body
    // (e.g. voice memos, plain images without caption) keep the
    // empty string so downstream consumers see consistent shapes.
    body: decoded ? body : body || `[whatsapp-personal:${type}]`,
    attachments: attachments.length ? attachments : undefined,
    raw: msg,
    receivedAt: new Date(ts),
    ...(Object.keys(flags).length > 0 ? { flags } : {}),
    ...(profile ? { senderProfile: profile } : {}),
  };
}

function buildWhatsAppSenderProfile(msg: BaileysWAMessage): SenderProfile | null {
  // In group threads, `participant` is the real sender JID — `remoteJid`
  // is the group itself. In DMs, `remoteJid` is the sender. Mirrors
  // `readSenderId()` so identity always tracks the real human, not the
  // chat container.
  const senderJid = msg.key.participant ?? msg.key.remoteJid;
  if (!senderJid) return null;

  const profile: SenderProfile = {};
  if (msg.pushName && msg.pushName.length > 0) {
    profile.displayName = msg.pushName;
  }
  // Preserve the JID verbatim — operators / downstream code may want
  // to distinguish @s.whatsapp.net from @lid contacts.
  profile.rawId = senderJid;
  // Only set phoneNumber when the JID encodes one. @lid carries an
  // opaque privacy id with no phone mapping in the message itself —
  // resolving it would need an extra `usync` Baileys call which we
  // deliberately skip to keep inbound latency tight.
  if (!isLidJid(senderJid)) {
    const digits = phoneFromJid(senderJid);
    if (digits.length > 0) profile.phoneNumber = digits;
  }
  return Object.keys(profile).length > 0 ? profile : null;
}

/**
 * Detect WhatsApp's Privacy-ID JID (`<id>@lid`). LID is a newer opaque
 * identifier WhatsApp issues to users who haven't shared their phone
 * with the bot — the JID looks like `1234567890@lid` (digits, but NOT
 * a phone number). Treating it as a phone would produce a garbage
 * "+1234…" the agent would print back at the user.
 */
export function isLidJid(jid: string): boolean {
  return jid.endsWith('@lid');
}

interface DecodedContent {
  body: string;
  attachments: Attachment[];
  type: string;
  /** False when the content didn't match any known variant — the
   *  caller substitutes a placeholder body in that case. */
  decoded: boolean;
}

function decodeContent(content: BaileysMessageContent): DecodedContent {
  // Plain text — `conversation` is the simple variant; `extendedTextMessage`
  // is the rich variant Baileys emits for messages with formatting,
  // mentions, or quoted replies.
  if (typeof content.conversation === 'string' && content.conversation.length > 0) {
    return { body: content.conversation, attachments: [], type: 'text', decoded: true };
  }
  if (content.extendedTextMessage?.text) {
    return { body: content.extendedTextMessage.text, attachments: [], type: 'text', decoded: true };
  }

  if (content.imageMessage) {
    return {
      body: content.imageMessage.caption ?? '',
      attachments: [
        { kind: 'image', mimeType: content.imageMessage.mimetype ?? 'image/jpeg' },
      ],
      type: 'image',
      decoded: true,
    };
  }
  if (content.videoMessage) {
    return {
      body: content.videoMessage.caption ?? '',
      attachments: [
        { kind: 'video', mimeType: content.videoMessage.mimetype ?? 'video/mp4' },
      ],
      type: 'video',
      decoded: true,
    };
  }
  if (content.audioMessage) {
    return {
      body: '',
      attachments: [
        { kind: 'audio', mimeType: content.audioMessage.mimetype ?? 'audio/ogg' },
      ],
      type: content.audioMessage.ptt ? 'voice' : 'audio',
      decoded: true,
    };
  }
  if (content.documentMessage) {
    const filename = content.documentMessage.fileName ?? undefined;
    return {
      body: content.documentMessage.caption ?? '',
      attachments: [
        {
          kind: 'file',
          mimeType: content.documentMessage.mimetype ?? 'application/octet-stream',
          ...(filename ? { filename } : {}),
        },
      ],
      type: 'document',
      decoded: true,
    };
  }
  if (content.stickerMessage) {
    return {
      body: '',
      attachments: [
        { kind: 'image', mimeType: content.stickerMessage.mimetype ?? 'image/webp' },
      ],
      type: 'sticker',
      decoded: true,
    };
  }
  if (content.reactionMessage) {
    return {
      body: content.reactionMessage.text ?? '',
      attachments: [],
      type: 'reaction',
      decoded: true,
    };
  }
  return { body: '', attachments: [], type: 'unknown', decoded: false };
}

/**
 * Resolve the sender — for groups the sender is `participant`, for
 * DMs it's `remoteJid`. We always return the *phone number* portion
 * so it's comparable with `masters.yaml` channel mappings.
 */
export function readSenderId(msg: BaileysWAMessage): string | null {
  const participant = msg.key.participant;
  const remote = msg.key.remoteJid;
  const jid = participant ?? remote;
  if (!jid) return null;
  return phoneFromJid(jid);
}

/**
 * Strip the WhatsApp JID suffix (`@s.whatsapp.net` / `@g.us`) and any
 * `:device` segment, returning bare digits. We do *not* prepend `+` —
 * masters.yaml channel mappings use the digits-only form to match the
 * Cloud API (`628…`).
 */
export function phoneFromJid(jid: string): string {
  const head = jid.split('@')[0] ?? '';
  const num = head.split(':')[0] ?? '';
  return num;
}

function readTimestamp(t: BaileysWAMessage['messageTimestamp']): number {
  if (typeof t === 'number') return t * 1000;
  if (t && typeof t === 'object' && 'low' in t) {
    // Long object — `low` holds the seconds value for any reasonable
    // unix time, since seconds since epoch fits in 32 bits until 2038.
    return (t as { low: number }).low * 1000;
  }
  return Date.now();
}

// ---- Phase 10A — group + mention helpers ----------------------------------

/**
 * Detect a group thread by remoteJid suffix (`@g.us`). Exported so the
 * channel-bridge / monitor pump can short-circuit on group messages
 * without re-parsing the JID.
 */
export function isGroupRemoteJid(remoteJid: string | undefined): boolean {
  return typeof remoteJid === 'string' && remoteJid.endsWith('@g.us');
}

/**
 * Phase 10A — detect a mention of the bot in `msg`.
 *
 * Sources of truth (in priority order):
 *   1. `extendedTextMessage.contextInfo.mentionedJid[]` — Baileys'
 *      structured mention list (most reliable; phone clients populate
 *      this whenever a user types `@<digits>` and picks a contact).
 *   2. Substring match of `selfDigits` (e.g. `628123…`) in the
 *      message body — covers manual mentions where the user typed
 *      the number without the autocomplete picker.
 *   3. Substring match of `@<selfDisplayName>` (case-insensitive) in
 *      the message body — covers human-friendly mentions like
 *      `@Athena`. Only triggered when `selfDisplayName` is supplied.
 *
 * Pure — never throws. Returns `false` when `opts.selfJid` is
 * missing (no way to know who the bot is).
 */
export function detectMention(
  msg: BaileysWAMessage,
  body: string,
  opts: NormaliseOptions,
): boolean {
  const selfDigits = opts.selfJid ? phoneFromJid(opts.selfJid) : null;
  const displayName = opts.selfDisplayName?.trim();

  if (!selfDigits && !displayName) return false;

  // (1) Structured mentionedJid list. Each entry is a full JID; we
  // compare digits-only so device suffixes don't trip the match.
  const mentionedJids =
    msg.message?.extendedTextMessage?.contextInfo?.mentionedJid ?? [];
  if (selfDigits && Array.isArray(mentionedJids)) {
    for (const j of mentionedJids) {
      if (typeof j === 'string' && phoneFromJid(j) === selfDigits) {
        return true;
      }
    }
  }

  // (2) Body substring of `@<digits>`. The phone client renders
  // mentions as a literal `@628…` token in the text body.
  if (selfDigits && body && body.includes(`@${selfDigits}`)) {
    return true;
  }

  // (3) Display-name mention — case-insensitive. Match `@<name>` only
  // (bare-name match would false-positive on regular speech).
  if (displayName && body) {
    const needle = `@${displayName}`.toLowerCase();
    if (body.toLowerCase().includes(needle)) return true;
  }

  return false;
}
