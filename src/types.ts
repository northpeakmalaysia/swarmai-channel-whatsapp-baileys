import { z } from '@swarmai/shared';

/**
 * Phase 9 — WhatsApp Personal mode (Baileys / WhatsApp Web protocol).
 *
 * Sibling to `@swarmai/channel-whatsapp` (Cloud API). The two packages
 * implement the same `ChannelPlugin` contract — interchangeable at the
 * gateway level via vault config.
 *
 * Personal mode connects to WhatsApp Web's WebSocket protocol via the
 * Baileys library. Authentication is via QR-code pairing (the operator
 * scans with their phone's WhatsApp → Linked Devices). No Meta business
 * account required; uses the operator's existing personal number.
 *
 * Trade-offs vs Cloud API:
 *   - Free, no business onboarding, instant setup.
 *   - One device per WhatsApp account (WhatsApp Web limitation).
 *   - Requires the linked phone to be online occasionally.
 *   - Against WhatsApp ToS technically (widely tolerated for personal
 *     use, never enforced). For commercial/high-volume, use Cloud API.
 *
 * Session storage: multi-file auth state at
 * `~/.swarmai/whatsapp-personal/<sessionId>/`. The directory should be
 * mode 0700 (operator-only readable) — we set this on creation.
 */

export const WhatsAppPersonalConfigSchema = z.object({
  /**
   * Session identifier — typically the operator's phone number once
   * paired. Used as the folder name under `~/.swarmai/whatsapp-personal/`.
   * Falls back to `default` for the first run before pairing completes.
   */
  sessionId: z.string().min(1).default('default'),
  /**
   * Absolute path to the session directory. When unset the plugin
   * derives it from `~/.swarmai/whatsapp-personal/<sessionId>/`.
   */
  sessionDir: z.string().optional(),
  /**
   * Print Baileys logs at this level. Defaults to `silent` because
   * Baileys is *very* chatty by default. Set to `warn` or `info` for
   * debugging via `DEBUG=swarmai:whatsapp-personal:*`.
   */
  logLevel: z
    .enum(['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('silent'),
  /**
   * Mark messages as read after the inbound handler resolves.
   * Defaults to true so the operator's phone doesn't accumulate
   * unread badges.
   */
  markRead: z.boolean().default(true),
  /**
   * Send a typing indicator while the agent is composing a reply.
   * Costs nothing extra (presence updates are cheap). Defaults to true.
   */
  typingIndicator: z.boolean().default(true),
  /**
   * Reconnect backoff base (ms). Doubles each consecutive failure up
   * to `reconnectMaxBackoffMs`. Default 1000 (1s).
   */
  reconnectBaseBackoffMs: z.number().int().positive().default(1000),
  /** Reconnect backoff cap (ms). Default 30000 (30s). */
  reconnectMaxBackoffMs: z.number().int().positive().default(30_000),
  /**
   * After this many consecutive failures, give up reconnecting and emit
   * a `channel.session-down` event. Default 5.
   */
  reconnectMaxAttempts: z.number().int().positive().default(5),
  /**
   * Phase 10A — when true, group messages that @-mention the operator's
   * own JID/phone-number are routed through the normal reply path
   * (i.e. `InboundEvent.flags.mentioned = true`). Otherwise group
   * messages flow only through the monitor side-channel for trigger
   * matching, and the agent never replies into a group unprompted.
   *
   * Defaults to true on Personal mode — the operator scanned the QR,
   * so a stranger can't trick the bot into replying. Cloud variant
   * defaults to false (different audiences — business numbers field
   * group invites from many directions).
   */
  respondToMentions: z.boolean().default(true),
  /**
   * Phase 10A — opt-in to a real `pino` logger for Baileys. By default
   * the wrapper uses a structural noop so Baileys' chatty defaults stay
   * silent. When investigating a Baileys connection issue, set this to
   * `true` (level=info) or `{ level: 'debug' }` for full instrumentation.
   *
   * Requires `pino` to be installed (peer dep, optional). When pino
   * isn't available, the wrapper falls back to the noop logger and
   * logs one warn line so the operator knows the flag had no effect.
   */
  useRealPino: z
    .union([
      z.boolean(),
      z.object({
        level: z
          .enum(['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace'])
          .default('info'),
      }),
    ])
    .optional(),
  /**
   * Phase 10A — heartbeat interval for the session-dir lockfile. Each
   * tick rewrites `.swarmai-lock` with the current timestamp so a peer
   * process can tell the holder is alive. Default 30s — three missed
   * ticks (90s) is treated as stale.
   */
  lockHeartbeatMs: z.number().int().positive().default(30_000),
  /**
   * Phase 10A — stale threshold for the session-dir lockfile. Older
   * than this and a peer process is allowed to take over the lock.
   * Default 90s — gives 3 missed heartbeats of slack.
   */
  lockStaleMs: z.number().int().positive().default(90_000),
});

/**
 * Personal mode has no auth secrets per se — credentials live in the
 * encrypted multi-file auth-state directory. The schema is empty for
 * structural compatibility with the Cloud variant.
 */
export const WhatsAppPersonalAuthSchema = z.object({}).passthrough();

export type WhatsAppPersonalConfig = z.infer<typeof WhatsAppPersonalConfigSchema>;
export type WhatsAppPersonalAuth = z.infer<typeof WhatsAppPersonalAuthSchema>;

/**
 * Subset of Baileys' `WAMessage` shape that we actually consume. We
 * declare a structural type rather than importing from Baileys so the
 * package can be parsed/typechecked without the heavy dependency
 * installed (Baileys is a peer dep, lazy-loaded).
 */
export interface BaileysWAMessage {
  key: {
    remoteJid: string;
    fromMe: boolean;
    id?: string;
    participant?: string;
  };
  message?: BaileysMessageContent;
  messageTimestamp?: number | Long;
  pushName?: string;
}

/** Baileys uses a `Long` shim in some places; structurally either a number or
 *  an object with `low`/`high`. We accept both. */
export type Long = { low: number; high: number; unsigned?: boolean } | number;

export interface BaileysMessageContent {
  conversation?: string;
  extendedTextMessage?: {
    text?: string;
    /**
     * Phase 10A — structured mention metadata. Phone clients populate
     * `mentionedJid[]` whenever the user picks a contact via the `@`
     * autocomplete; the inbound normaliser uses this as the primary
     * source of truth for mention detection.
     */
    contextInfo?: {
      mentionedJid?: string[];
      stanzaId?: string;
      participant?: string;
      quotedMessage?: BaileysMessageContent;
    };
  };
  imageMessage?: BaileysMediaMessage;
  videoMessage?: BaileysMediaMessage;
  audioMessage?: BaileysMediaMessage & { ptt?: boolean };
  documentMessage?: BaileysMediaMessage & { fileName?: string };
  stickerMessage?: BaileysMediaMessage;
  reactionMessage?: { text?: string; key?: BaileysWAMessage['key'] };
}

export interface BaileysMediaMessage {
  mimetype?: string;
  caption?: string;
  fileLength?: Long;
  url?: string;
}

/**
 * Connection status emitted by the Baileys client wrapper. The pair
 * flow listens for `connecting → qr → connected` and the plugin's
 * health check derives `ChannelHealth` from this.
 */
export type WhatsAppConnectionStatus =
  | 'idle'
  | 'connecting'
  | 'qr'
  | 'connected'
  | 'reconnecting'
  | 'session-expired'
  | 'session-down';
