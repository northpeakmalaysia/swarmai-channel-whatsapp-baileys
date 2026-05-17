import type {
  ChannelPlugin,
  ChannelContext,
  ChannelEmit,
  ChannelFeatures,
  ChannelHealth,
  OutboundEvent,
  InboundEvent,
  HttpRequest,
  MonitorEvent,
  MonitorSource,
} from '@swarmai/plugin-sdk';
import { logger as sharedLogger } from '@swarmai/shared';
import {
  WhatsAppPersonalConfigSchema,
  WhatsAppPersonalAuthSchema,
  type WhatsAppPersonalConfig,
} from './types.js';
import { BaileysClient, type BaileysAdapter } from './baileys-client.js';
import { normaliseBaileysMessage } from './inbound-normaliser.js';
import { sendOutboundText } from './outbound-sender.js';

/**
 * Per-attachment cap for auto-downloaded WhatsApp media. Mirrors
 * `MAX_ATTACHMENT_BYTES` in `apps/server/src/api/attachments.ts` so
 * downstream persistence won't reject a payload the channel already
 * fetched. Anything larger is skipped (logged at warn level) and the
 * attachment stays metadata-only — bridge then tells the agent the
 * bytes are unavailable instead of writing a half-downloaded file.
 */
const MAX_WA_MEDIA_BYTES = 5 * 1024 * 1024;

/**
 * `@swarmai/channel-whatsapp-personal` — Baileys-based WhatsApp Web
 * adapter.
 *
 * Mirrors the shape of `@swarmai/channel-whatsapp` (Cloud API):
 *   - `createWhatsAppPersonalPlugin()` returns a `WhatsAppPersonalBundle`
 *     containing both a `ChannelPlugin` (gateway) and a `MonitorSource`
 *     (monitor pipeline).
 *   - The two share state via a single `BaileysClient`.
 *   - The gateway plugin is interchangeable with the Cloud variant —
 *     `ChannelBridge.registerChannel(...)` accepts either.
 *
 * Lifecycle:
 *   1. `start(ctx, emit)` parses config, opens the session dir, and
 *      kicks off the Baileys client. Returns immediately — the
 *      WebSocket handshake completes asynchronously. Already-paired
 *      sessions reach `connected` within ~2-5s.
 *   2. Inbound `messages.upsert` events are normalised to
 *      `InboundEvent` and forwarded to `emit`.
 *   3. `send(event)` resolves the recipient JID and calls
 *      `client.sendText`. With `typingIndicator: true` (default),
 *      a `composing` presence update precedes the send.
 *   4. `stop()` ends the WebSocket and cancels reconnect timers.
 *
 * The bundle does NOT expose `handleWebhook` — Personal mode is
 * WebSocket-native and has no inbound HTTP surface. The `MonitorSource.webhook`
 * method returns `[]` to keep the contract honest.
 */

export const WHATSAPP_PERSONAL_FEATURES: ChannelFeatures = {
  dm: true,
  group: true,
  thread: false,
  reaction: true,
  edit: false,
  delete: false,
  mediaImage: true,
  mediaVideo: true,
  mediaAudio: true,
  voiceMemo: true,
  voiceCall: false,
  // Baileys exposes presence updates — we use them.
  typing: true,
  readReceipt: true,
  // Personal accounts get more relaxed limits than business but
  // we still throttle to avoid tripping anti-spam heuristics.
  formatting: 'platform',
  maxMessageBytes: 4096,
  maxAttachmentBytes: 16 * 1024 * 1024,
  rateLimit: { perMinute: 30, perHour: 500 },
};

export interface WhatsAppPersonalPluginOptions {
  /** Inject the Baileys adapter (tests). Default lazy-loads Baileys. */
  adapter?: BaileysAdapter;
  /** Optional alt-path inbound hook. The channel's `ChannelEmit`
   *  (wired via `start()`) is always called for every inbound event. */
  onEvent?: (e: InboundEvent) => void | Promise<void>;
  /** Listener for connection-lifecycle events — used by the server to
   *  surface session-down / session-expired alerts. */
  onConnectionEvent?: (event: WhatsAppPersonalConnectionEvent) => void;
  /**
   * Phase 10A — operator's friendly name (e.g. `Athena`). Used by the
   * inbound normaliser to detect `@<DisplayName>` mentions in group
   * messages. Optional — when unset, only digits-based mentions match.
   */
  selfDisplayName?: string;
  /**
   * Phase 11 (multi-slot) — override the channel + source identifier so
   * one factory can produce multiple slots. Defaults to
   * `DEFAULT_WHATSAPP_PERSONAL_ID` for the operator's primary channel
   * slot. Monitor slots typically pass `whatsapp-personal:<slug>` so the
   * bridge, vault, and dashboard pair routes can address each slot
   * uniquely.
   *
   * Validation rule: must match `[a-z0-9][a-z0-9._:-]*`. The pair-route
   * regex (`/api/channels/[^/]+/pair`) accepts `:` and the rest are URL-
   * safe in path segments.
   */
  channelId?: string;
}

export type WhatsAppPersonalConnectionEvent =
  | { kind: 'connecting' }
  | { kind: 'qr'; qr: string }
  | { kind: 'connected'; phoneNumber: string | null }
  | { kind: 'reconnecting'; attempt: number; delayMs: number }
  | { kind: 'disconnected'; reason: 'logged-out' | 'transient'; statusCode?: number; detail?: string }
  | { kind: 'session-expired'; statusCode?: number; detail?: string }
  | { kind: 'session-down'; attempts: number };

export interface WhatsAppPersonalBundle {
  channel: ChannelPlugin;
  source: MonitorSource;
  /** Direct access to the underlying client — useful for ops tooling
   *  (status, manual reconnect). */
  getClient(): BaileysClient | null;
  /**
   * Compatibility shim — the Cloud variant exposes `handleWebhook`;
   * Personal mode has no webhook so this always returns 405. Lets the
   * server's `channels` map carry both kinds without branching.
   */
  handleWebhook(req: HttpRequest): Promise<{
    status: number;
    body: string;
    inbound: InboundEvent[];
  }>;
  /**
   * 2026-05-17 — bridge-callable typing indicator. Wired by the slot
   * registration into `bridge.registerChannel({ sendTyping })` so the
   * "typing…" bubble shows during the agent's entire processing window
   * (not just the few seconds the outbound takes). No-op when the
   * operator has typingIndicator off in WA Personal Settings.
   */
  sendTyping(to: string): Promise<void>;
}

/**
 * Default identifier for the operator's primary WhatsApp Personal slot.
 * Distinct from `whatsapp` (the Cloud API variant) so a deployment can
 * mount both simultaneously without bridge collision.
 */
export const DEFAULT_WHATSAPP_PERSONAL_ID = 'whatsapp-personal';

const SLOT_ID_RE = /^[a-z0-9][a-z0-9._:-]*$/;

/**
 * Validate a slot id. Throws on invalid input — fail fast at boot so a
 * mistyped masters.yaml or vault entry surfaces immediately rather than
 * later when the dashboard's pair route silently 404s.
 */
function assertValidChannelId(id: string): void {
  if (!SLOT_ID_RE.test(id)) {
    throw new Error(
      `whatsapp-personal: invalid channelId "${id}" — must match ${SLOT_ID_RE}`,
    );
  }
}

/**
 * Factory — returns a fresh bundle. The channel id defaults to
 * `whatsapp-personal` for the primary slot; pass `channelId:
 * 'whatsapp-personal:<slug>'` to mount additional monitor slots that
 * share the bridge / dashboard surface but have isolated session dirs.
 */
export function createWhatsAppPersonalPlugin(
  opts: WhatsAppPersonalPluginOptions = {},
): WhatsAppPersonalBundle {
  const channelId = opts.channelId ?? DEFAULT_WHATSAPP_PERSONAL_ID;
  assertValidChannelId(channelId);

  let started = false;
  let config: WhatsAppPersonalConfig | null = null;
  let emit: ChannelEmit | null = null;
  let client: BaileysClient | null = null;
  let lastConnectionEvent: WhatsAppPersonalConnectionEvent | null = null;

  const channel: ChannelPlugin = {
    id: channelId,
    displayName: 'WhatsApp (Personal)',
    description: 'WhatsApp Web (Baileys) — pair via QR with your phone.',
    version: '0.0.1',
    kind: 'both',
    defaultDmPolicy: 'pairing',
    features: WHATSAPP_PERSONAL_FEATURES,
    authSchema: WhatsAppPersonalAuthSchema,
    configSchema: WhatsAppPersonalConfigSchema,

    async start(ctx: ChannelContext, emitFn: ChannelEmit): Promise<void> {
      config = WhatsAppPersonalConfigSchema.parse(ctx.config ?? {});
      emit = emitFn;
      // Validate auth schema even though it's empty — keeps parity
      // with the Cloud variant and surfaces wrong-shape vault data.
      WhatsAppPersonalAuthSchema.parse(ctx.secrets ?? {});

      client = new BaileysClient({
        config,
        ...(opts.adapter ? { adapter: opts.adapter } : {}),
      });

      client.on('connecting', () => {
        const e: WhatsAppPersonalConnectionEvent = { kind: 'connecting' };
        lastConnectionEvent = e;
        opts.onConnectionEvent?.(e);
      });
      client.on('qr', (qr: string) => {
        const e: WhatsAppPersonalConnectionEvent = { kind: 'qr', qr };
        lastConnectionEvent = e;
        opts.onConnectionEvent?.(e);
        sharedLogger.warn(
          'whatsapp-personal: QR pairing required — re-run `swarmai setup` to scan',
        );
      });
      client.on('connected', ({ phoneNumber }: { phoneNumber: string | null }) => {
        const e: WhatsAppPersonalConnectionEvent = { kind: 'connected', phoneNumber };
        lastConnectionEvent = e;
        opts.onConnectionEvent?.(e);
        sharedLogger.info({ phoneNumber }, 'whatsapp-personal: connected');
      });
      client.on('reconnecting', ({ attempt, delayMs }: { attempt: number; delayMs: number }) => {
        const e: WhatsAppPersonalConnectionEvent = { kind: 'reconnecting', attempt, delayMs };
        lastConnectionEvent = e;
        opts.onConnectionEvent?.(e);
      });
      client.on('disconnected', (info: { reason: 'logged-out' | 'transient'; statusCode?: number; detail?: string }) => {
        const e: WhatsAppPersonalConnectionEvent = {
          kind: 'disconnected',
          reason: info.reason,
          ...(info.statusCode !== undefined ? { statusCode: info.statusCode } : {}),
          ...(info.detail ? { detail: info.detail } : {}),
        };
        lastConnectionEvent = e;
        opts.onConnectionEvent?.(e);
      });
      client.on('session-expired', (info: { statusCode?: number; detail?: string }) => {
        const e: WhatsAppPersonalConnectionEvent = {
          kind: 'session-expired',
          ...(info.statusCode !== undefined ? { statusCode: info.statusCode } : {}),
          ...(info.detail ? { detail: info.detail } : {}),
        };
        lastConnectionEvent = e;
        opts.onConnectionEvent?.(e);
        sharedLogger.warn(
          { statusCode: info.statusCode, detail: info.detail },
          'whatsapp-personal: session expired — re-run `swarmai setup` to re-pair',
        );
      });
      client.on('session-down', ({ attempts }: { attempts: number }) => {
        const e: WhatsAppPersonalConnectionEvent = { kind: 'session-down', attempts };
        lastConnectionEvent = e;
        opts.onConnectionEvent?.(e);
        sharedLogger.warn({ attempts }, 'whatsapp-personal: gave up reconnecting');
      });
      client.on('error', (err: unknown) => {
        sharedLogger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'whatsapp-personal: client error',
        );
      });

      client.on('message', async (msg) => {
        try {
          // Phase 10A — pass selfJid + displayName so the normaliser
          // can detect @-mentions of the operator's own number /
          // friendly name. selfDisplayName is sourced from
          // `opts.selfDisplayName` (set at boot from masters.yaml or
          // agent.yaml). selfJid is read live from the socket.
          const ev = normaliseBaileysMessage(channelId, msg, {
            ...(client?.getOwnJid() ? { selfJid: client.getOwnJid()! } : {}),
            ...(opts.selfDisplayName ? { selfDisplayName: opts.selfDisplayName } : {}),
          });
          if (!ev) return;

          // 2026-05-17 — auto-download inbound media bytes for image +
          // document attachments. WhatsApp media is E2E-encrypted, so
          // without a Baileys decrypt step the bridge persists no bytes
          // and the agent sees `[attached: ... bytes unavailable]` —
          // routing fails before analyze_image ever runs. Per operator
          // decision (2026-05-17): images + documents only. Audio /
          // video / stickers stay metadata-only so a 50 MB voice note
          // doesn't burn bandwidth + disk every time. Per-attachment
          // cap (MAX_WA_MEDIA_BYTES) mirrors `attachments.ts`.
          if (ev.attachments && ev.attachments.length > 0 && client) {
            for (const att of ev.attachments) {
              if (att.kind !== 'image' && att.kind !== 'file') continue;
              const bytes = await client.downloadMedia(msg);
              if (!bytes) continue;
              if (bytes.byteLength > MAX_WA_MEDIA_BYTES) {
                sharedLogger.warn(
                  {
                    channelId,
                    kind: att.kind,
                    sizeBytes: bytes.byteLength,
                    capBytes: MAX_WA_MEDIA_BYTES,
                  },
                  'whatsapp-personal: inbound media exceeds cap, skipping download',
                );
                continue;
              }
              att.data = new Uint8Array(bytes);
            }
          }
          // Phase 10A — group messages without an @-mention bypass the
          // bridge's reply path when `respondToMentions` is on. They
          // still flow through the monitor side-channel via the
          // bridge's `onIncoming` listeners (Phase 5A) so triggers can
          // match. The flag is what tells the bridge to short-circuit
          // — see channel-bridge in main.ts wiring.
          const isGroup = ev.flags?.['groupChat'] === true;
          const wasMentioned = ev.flags?.['mentioned'] === true;
          const shouldRouteToBridge =
            !isGroup ||
            !config!.respondToMentions ||
            wasMentioned;
          if (shouldRouteToBridge && emit) await emit(ev);
          if (opts.onEvent) await opts.onEvent(ev);
          // Mark the message as read once the inbound handler resolved
          // — this keeps the operator's phone unread badge clean.
          if (config?.markRead) {
            await client?.markRead([msg.key]);
          }
        } catch (err) {
          sharedLogger.warn(
            { err: err instanceof Error ? err.message : String(err) },
            'whatsapp-personal: inbound handler threw',
          );
        }
      });

      await client.start();
      started = true;
    },

    async stop(): Promise<void> {
      if (client) {
        await client.stop();
        client = null;
      }
      started = false;
      emit = null;
    },

    async healthCheck(): Promise<ChannelHealth> {
      if (!started || !client) return { status: 'down', detail: 'not started' };
      const status = client.getStatus();
      switch (status) {
        case 'connected':
          return { status: 'ok' };
        case 'connecting':
        case 'qr':
        case 'reconnecting':
          return { status: 'degraded', detail: status };
        case 'session-expired':
        case 'session-down':
        case 'idle':
        default:
          return { status: 'down', detail: status };
      }
    },

    async send(event: OutboundEvent): Promise<void> {
      if (!started || !client || !config) {
        throw new Error('whatsapp-personal channel not started');
      }
      if (event.channelId !== channelId) {
        throw new Error(
          `channelId mismatch: got ${event.channelId}, expected ${channelId}`,
        );
      }
      // Phase 10A — `sendOutboundText` now handles attachments
      // (image/video/audio/file) in addition to plain text. The name is
      // a back-compat shim; attachments flow through the same call.
      const result = await sendOutboundText(
        {
          client,
          channelId: channelId,
          ...(config.typingIndicator
            ? {
                onBeforeSend: (jid: string) => client!.setTyping(jid, true),
                onAfterSend: (jid: string) => client!.setTyping(jid, false),
              }
            : {}),
        },
        event,
      );
      if (!result.ok) {
        throw new Error(`whatsapp-personal send failed: ${result.detail ?? 'unknown'}`);
      }
    },
  };

  /**
   * 2026-05-17 — inbound-anchored typing indicator hook for the bridge.
   * Called by ChannelBridge every ~4s during agent processing (between
   * inbound arrival and reply dispatch) so the contact sees a "typing…"
   * bubble during the entire turn, not just the few seconds the channel
   * spends serialising the outbound. No-op when:
   *   - `config.typingIndicator` is off (operator opt-out)
   *   - the socket isn't connected (channel still pairing / reconnecting)
   * Errors are swallowed by the caller (typing is best-effort UX).
   *
   * Note: this is wired by `main-whatsapp-personal-slots.ts` into
   * `bridge.registerChannel({ sendTyping })`. The bridge does its own
   * `@lid` recovery on the `to` argument before calling this, so any
   * bare-digits sender from `event.from` arrives already JID-shaped.
   */
  const sendTypingHook = async (to: string): Promise<void> => {
    if (!started || !client || !config) return;
    if (!config.typingIndicator) return;
    await client.setTyping(to, true);
  };

  const source: MonitorSource = {
    id: channelId,
    kind: 'push',
    authSchema: WhatsAppPersonalAuthSchema,
    configSchema: WhatsAppPersonalConfigSchema,
    async healthCheck() {
      if (!started || !client) return 'down';
      const s = client.getStatus();
      return s === 'connected' ? 'ok' : s === 'session-down' || s === 'session-expired' ? 'down' : 'degraded';
    },
    async webhook(_req: HttpRequest): Promise<MonitorEvent[]> {
      // Personal mode is WebSocket-native — no inbound HTTP path. Return
      // empty so callers that mount this on a webhook router get a
      // graceful 200/no-events instead of an exception.
      return [];
    },
  };

  function handleWebhook(_req: HttpRequest): Promise<{
    status: number;
    body: string;
    inbound: InboundEvent[];
  }> {
    // Personal mode has no webhook — keep the surface symmetric with
    // the Cloud variant by returning a 405 instead of throwing.
    return Promise.resolve({
      status: 405,
      body: '{"error":"whatsapp-personal has no webhook"}',
      inbound: [],
    });
  }

  return {
    channel,
    source,
    handleWebhook,
    getClient: () => client,
    sendTyping: sendTypingHook,
    // Tests / ops-tooling can read the last connection event.
    // (Not in the public type because callers shouldn't depend on it
    //  beyond observability.)
    ...({} as { _lastEvent?: () => WhatsAppPersonalConnectionEvent | null }),
    _lastEvent: () => lastConnectionEvent,
  } as WhatsAppPersonalBundle & { _lastEvent: () => WhatsAppPersonalConnectionEvent | null };
}

/**
 * MonitorSource-only factory — returns just the source half of the
 * bundle for callers (the monitor pipeline) that don't need the
 * channel half. Mirrors the Cloud variant's pattern.
 */
export function createWhatsAppPersonalMonitorSource(
  opts: WhatsAppPersonalPluginOptions = {},
): MonitorSource {
  return createWhatsAppPersonalPlugin(opts).source;
}

/**
 * Phase 11 — monitor-only bundle. Delegates to the standard factory
 * but rewrites `channel.send` to throw, marking the slot as
 * inbound-only at the contract level. The agent's outbound path will
 * see the channel id is "registered" on the bridge but `send` rejects
 * — surfaces clearly in logs as "monitor-only slot".
 *
 * Why expose a separate factory rather than have the host suppress
 * `bridge.registerChannel`: lets ops tooling (the dashboard's Channels
 * pane, `swarmai channel list`) distinguish "this slot exists, but
 * outbound is forbidden by design" from "outbound failed — broken
 * adapter".
 *
 * Contract changes vs the regular bundle:
 *   - `channel.kind === 'monitor'` (was `'both'`).
 *   - `channel.send` throws `MonitorOnlySlotError` synchronously.
 *   - `channel.features.dm = false`, `group = false` — operator can't
 *     send to anyone via this slot. Inbound routing is unchanged.
 */
export class MonitorOnlySlotError extends Error {
  constructor(channelId: string) {
    super(
      `whatsapp-personal: slot "${channelId}" is monitor-only — outbound not allowed. ` +
        `Use the primary "whatsapp-personal" channel slot for replies.`,
    );
    this.name = 'MonitorOnlySlotError';
  }
}

export function createWhatsAppPersonalMonitorOnlyBundle(
  opts: WhatsAppPersonalPluginOptions = {},
): WhatsAppPersonalBundle {
  const base = createWhatsAppPersonalPlugin(opts);
  const channelId = opts.channelId ?? DEFAULT_WHATSAPP_PERSONAL_ID;
  // Wrap the channel so `send()` throws and `kind`/`features` reflect
  // the monitor-only contract. We can't mutate the underlying plugin
  // safely (it's used by the source half), so we shadow it.
  const monitorChannel: ChannelPlugin = {
    ...base.channel,
    kind: 'monitor-source',
    features: {
      ...base.channel.features,
      dm: false,
      group: false,
    },
    async send(): Promise<void> {
      throw new MonitorOnlySlotError(channelId);
    },
  };
  return {
    ...base,
    channel: monitorChannel,
  };
}
