import type { Attachment, OutboundEvent } from '@swarmai/plugin-sdk';
import type { BaileysClient } from './baileys-client.js';
import { normaliseForWhatsApp } from './format.js';

/**
 * Outbound — translate an `OutboundEvent` into Baileys' `sendMessage`
 * call.
 *
 * Baileys uses *JIDs* (Jabber-style ids) where the Cloud API uses raw
 * phone numbers. We accept either form on input and rewrite to a JID
 * before sending:
 *   - `+62812…` / `62812…` → `62812…@s.whatsapp.net`
 *   - `<group>@g.us` (already a group JID) → unchanged
 *
 * Phase 10A — full media support. Each attachment in
 * `OutboundEvent.attachments` is dispatched as a separate Baileys
 * `sendMessage` call:
 *   - `image/*`                       → `{ image: Buffer, caption }`
 *   - `video/*`                       → `{ video: Buffer, caption }`
 *   - `audio/* (ptt)`                 → `{ audio: Buffer, ptt: true, mimetype }`
 *   - `audio/*`                       → `{ audio: Buffer, mimetype }`
 *   - `application/* / other`         → `{ document: Buffer, mimetype, fileName }`
 *
 * The caller may supply media as `Buffer` / `Uint8Array` (via
 * `attachment.data`) or as a URL string (`attachment.url`). When a URL
 * is given we fetch it once via `globalThis.fetch` and pass the bytes
 * to Baileys — Baileys does support URL-direct sends but they're
 * unreliable across regions and we want size-cap enforcement.
 *
 * Size caps (WhatsApp's Cloud API limits, mirrored on Personal):
 *   image / video : 16 MB
 *   audio         : 16 MB
 *   document      : 100 MB
 *
 * On oversize the sender returns `{ ok: false }` with a clear detail
 * — Baileys would silently truncate or reject server-side, neither of
 * which surfaces well to the operator.
 */

export interface SendOutcome {
  ok: boolean;
  messageId?: string;
  detail?: string;
}

export interface OutboundDeps {
  client: BaileysClient;
  /** Channel id this plugin advertises. Used to validate `event.channelId`. */
  channelId: string;
  /** Optional pre-send hook (typing indicator). Default no-op. */
  onBeforeSend?: (jid: string) => Promise<void>;
  /** Optional post-send hook (clear typing). Default no-op. */
  onAfterSend?: (jid: string) => Promise<void>;
  /** Inject a fetch implementation for URL-sourced media (tests). */
  fetchImpl?: (url: string) => Promise<{
    ok: boolean;
    status: number;
    arrayBuffer(): Promise<ArrayBuffer>;
  }>;
}

/** Maximum attachment size by attachment kind, in bytes. */
export const MEDIA_SIZE_CAPS: Record<Attachment['kind'], number> = {
  image: 16 * 1024 * 1024,
  video: 16 * 1024 * 1024,
  audio: 16 * 1024 * 1024,
  file: 100 * 1024 * 1024,
};

/**
 * v1 entry point — sends `event.body` as text plus zero-or-more
 * attachments. Renamed conceptually but kept as `sendOutboundText` for
 * back-compat (the outer plugin.ts already calls this, callers
 * unchanged). When attachments are present the first attachment
 * carries the body as a caption (image/video/document); subsequent
 * attachments are sent without caption to avoid duplication. Plain
 * audio/voice ignore the caption (WhatsApp doesn't support audio
 * captions natively); a separate trailing text send carries the body
 * if no other media accepted it.
 */
export async function sendOutboundText(
  deps: OutboundDeps,
  event: OutboundEvent,
): Promise<SendOutcome> {
  if (event.channelId !== deps.channelId) {
    return {
      ok: false,
      detail: `channelId mismatch: got ${event.channelId}, expected ${deps.channelId}`,
    };
  }
  const hasAttachments = (event.attachments?.length ?? 0) > 0;
  if ((!event.body || event.body.length === 0) && !hasAttachments) {
    return { ok: false, detail: 'empty body — refusing to send' };
  }
  // Issue #10 — normalise outbound body for WhatsApp's supported markdown
  // (drop `[label](url)` and `# Heading`; preserve *bold* / _italic_).
  // Applies to both the standalone text send and to media captions.
  const body = event.body ? normaliseForWhatsApp(event.body) : event.body;
  const jid = toJid(event.to);
  if (!jid) {
    return { ok: false, detail: `cannot resolve recipient JID from "${event.to}"` };
  }
  if (deps.onBeforeSend) {
    try {
      await deps.onBeforeSend(jid);
    } catch {
      /* typing-indicator failure is never fatal */
    }
  }

  let lastMessageId: string | undefined;
  let captionConsumed = false;
  try {
    if (hasAttachments) {
      for (const att of event.attachments ?? []) {
        const validation = validateAttachment(att);
        if (!validation.ok) {
          return { ok: false, detail: validation.detail };
        }
        let buffer: Buffer;
        try {
          buffer = await resolveMediaBuffer(att, deps.fetchImpl);
        } catch (err) {
          return {
            ok: false,
            detail: `media fetch failed: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
        const cap = MEDIA_SIZE_CAPS[att.kind];
        if (buffer.byteLength > cap) {
          return {
            ok: false,
            detail:
              `attachment exceeds size cap (${formatMb(buffer.byteLength)} > ` +
              `${formatMb(cap)} for ${att.kind})`,
          };
        }
        const supportsCaption = att.kind === 'image' || att.kind === 'video' || att.kind === 'file';
        const caption = !captionConsumed && supportsCaption ? body : undefined;
        if (caption !== undefined) captionConsumed = true;

        const content = buildMediaContent(att, buffer, caption);
        const id = await deps.client.sendMessage(jid, content);
        if (id) lastMessageId = id;
      }
      // No caption-bearing attachment consumed the body? Fall through to
      // a trailing text send so the operator's words still arrive.
      if (!captionConsumed && body && body.length > 0) {
        const id = await deps.client.sendText(jid, body);
        if (id) lastMessageId = id;
      }
    } else {
      const id = await deps.client.sendText(jid, body);
      if (id) lastMessageId = id;
    }

    if (deps.onAfterSend) {
      try {
        await deps.onAfterSend(jid);
      } catch {
        /* never fatal */
      }
    }
    return { ok: true, ...(lastMessageId ? { messageId: lastMessageId } : {}) };
  } catch (err) {
    return {
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Convert a phone number / JID input to a Baileys-compatible JID.
 * Returns null when the input can't sensibly be turned into one.
 */
export function toJid(to: string): string | null {
  const trimmed = to.trim();
  if (!trimmed) return null;
  // Already a JID — accept as-is.
  if (trimmed.includes('@')) return trimmed;
  // Phone number → strip non-digits, append the standard suffix.
  const digits = trimmed.replace(/[^\d]/g, '');
  if (!digits) return null;
  return `${digits}@s.whatsapp.net`;
}

/**
 * Detect whether a JID belongs to a group. Useful for the channel-bridge's
 * group-message handling logic.
 */
export function isGroupJid(jid: string): boolean {
  return jid.endsWith('@g.us');
}

// ---- Phase 10A — media helpers --------------------------------------------

/**
 * Validate an attachment's mime-type / structure before we fetch the
 * bytes. Cheap up-front check so a typo in `mimeType` fails fast
 * without a network round-trip.
 */
export function validateAttachment(att: Attachment): { ok: true } | { ok: false; detail: string } {
  if (!att.mimeType || typeof att.mimeType !== 'string') {
    return { ok: false, detail: 'attachment.mimeType is required' };
  }
  const lc = att.mimeType.toLowerCase();
  switch (att.kind) {
    case 'image':
      if (!lc.startsWith('image/')) return { ok: false, detail: `image kind expects image/*, got ${att.mimeType}` };
      break;
    case 'video':
      if (!lc.startsWith('video/')) return { ok: false, detail: `video kind expects video/*, got ${att.mimeType}` };
      break;
    case 'audio':
      if (!lc.startsWith('audio/')) return { ok: false, detail: `audio kind expects audio/*, got ${att.mimeType}` };
      break;
    case 'file':
      // Documents accept anything — application/*, text/*, etc.
      break;
    default:
      return { ok: false, detail: `unsupported attachment kind: ${(att as { kind?: string }).kind ?? 'unset'}` };
  }
  if (!att.data && !att.url) {
    return { ok: false, detail: 'attachment must supply either data or url' };
  }
  return { ok: true };
}

/**
 * Detect whether an audio attachment is a voice memo (PTT) based on
 * the standard WhatsApp opus mime suffix.
 */
export function isVoiceMemo(mimeType: string): boolean {
  return mimeType.toLowerCase().includes('ogg') && mimeType.toLowerCase().includes('opus');
}

/**
 * Resolve an Attachment's bytes into a Buffer. `data` (Uint8Array /
 * Buffer) is used directly; `url` triggers a single fetch.
 */
export async function resolveMediaBuffer(
  att: Attachment,
  fetchImpl?: OutboundDeps['fetchImpl'],
): Promise<Buffer> {
  if (att.data) {
    return Buffer.isBuffer(att.data) ? (att.data as Buffer) : Buffer.from(att.data);
  }
  if (!att.url) {
    throw new Error('attachment has neither data nor url');
  }
  const f =
    fetchImpl ??
    ((url: string) =>
      (globalThis.fetch as unknown as (u: string) => Promise<{
        ok: boolean;
        status: number;
        arrayBuffer(): Promise<ArrayBuffer>;
      }>)(url));
  const res = await f(att.url);
  if (!res.ok) {
    throw new Error(`fetch ${att.url} returned ${res.status}`);
  }
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}

/**
 * Build the Baileys `sendMessage` content payload for one attachment +
 * optional caption. Returns the structurally-typed content object —
 * Baileys accepts any of `image / video / audio / document` keys.
 */
export function buildMediaContent(
  att: Attachment,
  buffer: Buffer,
  caption: string | undefined,
): Record<string, unknown> {
  const mimetype = att.mimeType;
  switch (att.kind) {
    case 'image':
      return { image: buffer, mimetype, ...(caption ? { caption } : {}) };
    case 'video':
      return { video: buffer, mimetype, ...(caption ? { caption } : {}) };
    case 'audio':
      return {
        audio: buffer,
        mimetype,
        // PTT flag — Baileys uses this to render as a voice memo bubble
        // instead of an audio clip with playback chrome.
        ...(isVoiceMemo(mimetype) ? { ptt: true } : {}),
      };
    case 'file':
      return {
        document: buffer,
        mimetype,
        ...(att.filename ? { fileName: att.filename } : {}),
        ...(caption ? { caption } : {}),
      };
    default:
      // validateAttachment guards this — defensive only.
      return { text: caption ?? '' };
  }
}

function formatMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
