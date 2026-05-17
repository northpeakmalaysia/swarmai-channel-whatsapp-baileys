import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync } from 'node:fs';
import type { WhatsAppPersonalConfig, BaileysWAMessage, WhatsAppConnectionStatus } from './types.js';
import {
  ensureSessionDir,
  acquireSessionLock,
  type SessionLockHandle,
} from './session-store.js';
import { logger as sharedLogger } from '@swarmai/shared';

/**
 * Per-call timeout caps for outbound Baileys sends. Without these the
 * caller waits for Baileys' internal ~80s timeout — which surfaces as
 * a generic "Timed Out" error with no operation context. Our wrapper
 * fails faster and tells the agent WHAT timed out (text vs media kind).
 *
 * Text sends should complete in <2s on a healthy connection — 15s gives
 * generous headroom. Media uploads are size-bound (Baileys must upload
 * the bytes to WhatsApp's CDN, then dispatch the message); 45s covers
 * typical document sends comfortably while still failing well before
 * the agent's own tool-call budget.
 */
const SEND_TIMEOUT_TEXT_MS = 15_000;
const SEND_TIMEOUT_MEDIA_MS = 45_000;

/**
 * Race a send-promise against a timeout, rejecting with a classified
 * error after `timeoutMs`. The `kind` string ends up in the agent-facing
 * error message — keep it short and descriptive ("text" / "document" /
 * "image" etc.) so the agent can decide whether to retry, switch
 * channels, or fall back to a different attachment format.
 */
function withSendTimeout<T>(p: Promise<T>, timeoutMs: number, kind: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `whatsapp-personal: send timed out after ${timeoutMs}ms (waiting for WhatsApp ACK on ${kind}). ` +
            'Common causes: stale Baileys session, non-existent destination JID, WhatsApp Web rate limit.',
        ),
      );
    }, timeoutMs);
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

/** Best-effort description of a Baileys content object for error messages. */
function describeContent(content: Record<string, unknown>): string {
  if ('image' in content) return 'image';
  if ('video' in content) return 'video';
  if ('audio' in content) return 'audio';
  if ('document' in content) {
    const fn = (content as { fileName?: string }).fileName;
    return fn ? `document(${fn})` : 'document';
  }
  if ('text' in content) return 'text';
  return 'message';
}

/** Best-effort buffer size lookup for diagnostic logs — works for the
 *  image/video/audio/document content shapes Baileys' sendMessage takes. */
function contentByteSize(content: Record<string, unknown>): number {
  for (const key of ['image', 'video', 'audio', 'document'] as const) {
    const v = content[key];
    if (Buffer.isBuffer(v)) return v.byteLength;
    if (v instanceof Uint8Array) return v.byteLength;
  }
  return 0;
}

/**
 * `BaileysClient` — thin event-emitter wrapper around Baileys'
 * `makeWASocket` flow.
 *
 * Why a wrapper:
 *   - Baileys exposes a heavy, callback-style API tightly coupled to
 *     its internal types. The plugin only needs four signals
 *     (`qr`, `connected`, `disconnected`, `message`) plus `sendText`,
 *     and we want a unit-testable seam.
 *   - The CLI's pair flow uses the same wrapper to drive the QR loop
 *     without instantiating the full plugin (which expects a server
 *     `ChannelEmit` callback to be wired).
 *
 * DI seam: `BaileysAdapter` is the structural interface the wrapper
 * builds against. The default impl wraps Baileys; tests pass a fake
 * adapter so unit tests don't load Baileys (15+ MB dep, native
 * crypto) or open real WebSockets.
 */

export interface BaileysAdapter {
  /** Build the multi-file auth state from the session dir. */
  loadAuthState(sessionDir: string): Promise<{
    state: unknown;
    saveCreds: () => Promise<void>;
  }>;

  /** Construct + start a Baileys socket. Returns the socket handle. */
  makeSocket(args: {
    auth: unknown;
    logger?: unknown;
    printQRInTerminal?: boolean;
  }): BaileysSocketHandle;
}

/**
 * Subset of Baileys' socket API we use. Structural — Baileys'
 * `WASocket` type extends EventEmitter and exposes these methods.
 */
export interface BaileysSocketHandle {
  ev: {
    on(event: 'connection.update', cb: (u: BaileysConnectionUpdate) => void): void;
    on(event: 'creds.update', cb: () => void): void;
    on(event: 'messages.upsert', cb: (u: { messages: BaileysWAMessage[]; type: string }) => void): void;
    off?(event: string, cb: (...args: unknown[]) => void): void;
    removeAllListeners?(event?: string): void;
  };
  user?: { id?: string };
  sendMessage(jid: string, content: unknown): Promise<{ key?: { id?: string } } | undefined>;
  sendPresenceUpdate?(presence: 'composing' | 'paused' | 'available' | 'unavailable', toJid?: string): Promise<void>;
  readMessages?(keys: Array<BaileysWAMessage['key']>): Promise<void>;
  end?(error?: Error | undefined): void | Promise<void>;
  ws?: { close?: () => void };
  logout?: () => Promise<void>;
}

export interface BaileysConnectionUpdate {
  connection?: 'open' | 'close' | 'connecting';
  qr?: string;
  lastDisconnect?: {
    error?: { output?: { statusCode?: number }; message?: string } | Error;
  };
}

export interface BaileysClientOptions {
  config: WhatsAppPersonalConfig;
  /** Inject an adapter (tests). Default: lazy-load Baileys. */
  adapter?: BaileysAdapter;
  /** Inject a logger. Default: shared logger silenced for prod. */
  loggerOverride?: unknown;
}

/**
 * Events emitted:
 *   - `qr` (qr: string)
 *   - `connecting` ()
 *   - `connected` ({ phoneNumber: string })
 *   - `disconnected` ({ reason: 'logged-out' | 'transient'; statusCode?: number; detail?: string })
 *   - `session-expired` ({ statusCode: number; detail?: string })
 *   - `handshake-rejected` ({ statusCode?: number; detail?: string }) — WS
 *       closed before any QR or open frame, i.e. WhatsApp rejected the
 *       client outright. Distinct from `disconnected` (which fires
 *       *after* a successful pair when WA flaps the connection). The
 *       pair-ui flow listens for this so it can surface a clear error
 *       to the operator instead of letting the reconnect ladder loop.
 *   - `session-down` ({ attempts: number })  — after exhausting retries
 *   - `reconnecting` ({ attempt: number; delayMs: number })
 *   - `message` (msg: BaileysWAMessage)
 *   - `error` (err: Error)
 */
export class BaileysClient extends EventEmitter {
  private readonly config: WhatsAppPersonalConfig;
  private readonly adapter: BaileysAdapter;
  private readonly loggerArg: unknown;
  private socket: BaileysSocketHandle | null = null;
  private status: WhatsAppConnectionStatus = 'idle';
  private consecutiveFailures = 0;
  /**
   * True once Baileys has reached `connection: 'open'` at least once
   * on this client instance. Used to distinguish a *pair-phase* close
   * (WhatsApp rejected our handshake — terminal, surface to operator)
   * from a *mid-session* close (transient flap — retry quietly).
   */
  private hasOpened = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopRequested = false;
  private saveCreds: (() => Promise<void>) | null = null;
  private sessionDir: string | null = null;
  private phoneNumber: string | null = null;
  private lockHandle: SessionLockHandle | null = null;

  constructor(opts: BaileysClientOptions) {
    super();
    this.config = opts.config;
    this.adapter = opts.adapter ?? defaultBaileysAdapter();
    this.loggerArg = opts.loggerOverride ?? defaultBaileysLogger(opts.config);
  }

  /** Current connection status. */
  getStatus(): WhatsAppConnectionStatus {
    return this.status;
  }

  /** Phone number once known (after `connected`). */
  getPhoneNumber(): string | null {
    return this.phoneNumber;
  }

  /** Resolved session dir (after `start`). Useful for the pair flow. */
  getSessionDir(): string | null {
    return this.sessionDir;
  }

  /** Spin up the Baileys socket. Returns when the socket is wired
   *  (events have been registered). Does NOT wait for `connected` —
   *  callers listen for `qr` / `connected`. */
  async start(): Promise<void> {
    this.stopRequested = false;
    // Override path: `config.sessionDir` is the single source of truth.
    // We MUST NOT call ensureSessionDir() in this branch — its
    // `resolveSessionPaths()` would fall back to the workspace default
    // (`<workspaceRoot>/whatsapp-personal/<sessionId>/`) and silently
    // mkdir an empty folder there. That bug leaked one folder per test
    // run into the operator's REAL `~/.swarmai/whatsapp-personal/`
    // (every `pair-flow.test.ts` / `pair-ui.test.ts` `sessionId` —
    // `happy`, `cancel`, `down`, `to`, `test-pair`, `test-${Date.now()}`,
    // …) and conflicted with `swarmai whatsapp pair`'s "Sessions found"
    // guard. Default path still uses ensureSessionDir for chmod 0700.
    if (this.config.sessionDir) {
      this.sessionDir = this.config.sessionDir;
      if (!existsSync(this.sessionDir)) {
        mkdirSync(this.sessionDir, { recursive: true });
      }
    } else {
      const paths = ensureSessionDir({ sessionId: this.config.sessionId });
      this.sessionDir = paths.sessionDir;
    }

    // Phase 10A — acquire single-instance lock before Baileys touches
    // the session dir. Throws SessionLockedError when another fresh
    // process holds the lock; takes over stale locks with a warn log.
    // Skipped on reconnect attempts (lockHandle already set) so the
    // heartbeat keeps ticking through transient disconnects.
    if (!this.lockHandle) {
      this.lockHandle = acquireSessionLock({
        sessionDir: this.sessionDir,
        heartbeatMs: this.config.lockHeartbeatMs,
        staleMs: this.config.lockStaleMs,
      });
    }

    const { state, saveCreds } = await this.adapter.loadAuthState(this.sessionDir);
    this.saveCreds = saveCreds;

    this.setStatus('connecting');
    this.emit('connecting');

    const socket = this.adapter.makeSocket({
      auth: state,
      logger: this.loggerArg,
      printQRInTerminal: false, // we handle QR rendering ourselves
    });
    this.socket = socket;

    socket.ev.on('connection.update', (update) => this.handleConnectionUpdate(update));
    socket.ev.on('creds.update', () => {
      // Persist credentials whenever Baileys updates them.
      if (this.saveCreds) {
        this.saveCreds().catch((err) => {
          sharedLogger.warn(
            { err: err instanceof Error ? err.message : String(err) },
            'whatsapp-personal: saveCreds failed',
          );
        });
      }
    });
    socket.ev.on('messages.upsert', ({ messages }) => {
      for (const msg of messages) this.handleMessage(msg);
    });
  }

  /** Send a text message to a JID (`+phone@s.whatsapp.net` or
   *  `<group>@g.us`). Resolves with the message id on success. */
  async sendText(jid: string, body: string): Promise<string | undefined> {
    if (!this.socket) throw new Error('whatsapp-personal: socket not started');
    this.assertConnectedForSend('text');
    const r = await withSendTimeout(
      this.socket.sendMessage(jid, { text: body }),
      SEND_TIMEOUT_TEXT_MS,
      'text',
    );
    return r?.key?.id;
  }

  /**
   * Phase 10A — send an arbitrary Baileys content object. Used by the
   * outbound media helpers to dispatch image/video/audio/document
   * messages (`{ image: Buffer, caption }` etc.). Resolves with the
   * message id when the underlying call succeeds.
   *
   * Kept separate from `sendText` so the simple text path stays cheap
   * and the media path can be unit-tested without dragging Baileys in.
   *
   * Diagnostic instrumentation (2026-05-17): emits heartbeat logs every
   * 10s while a media send is in flight, so when the 45s timeout fires
   * the operator can tell which Baileys sub-step likely hung:
   *   - Failure at ~0-2s → pre-key bundle fetch or auth issue
   *   - Failure at ~5-15s → mediaConn refresh (`iq xmlns="w:m"`) hung
   *   - Failure at ~15-45s → HTTPS upload to mmg.whatsapp.net (the most
   *     common service-context failure mode — the WebSocket is healthy
   *     but the separate media-CDN connection is blocked or stale)
   *   - Failure right at 45s + heartbeats fired regularly → relay step
   *     after upload completed
   * Without these heartbeats the failure is a single opaque "Timed Out".
   */
  async sendMessage(jid: string, content: Record<string, unknown>): Promise<string | undefined> {
    if (!this.socket) throw new Error('whatsapp-personal: socket not started');
    this.assertConnectedForSend('media');
    const kind = describeContent(content);
    const bytes = contentByteSize(content);
    const t0 = Date.now();
    sharedLogger.info({ jid, kind, bytes }, 'whatsapp-personal: media send starting');
    const heartbeat = setInterval(() => {
      const elapsedMs = Date.now() - t0;
      sharedLogger.warn(
        { jid, kind, bytes, elapsedMs },
        `whatsapp-personal: media send still in flight after ${Math.round(elapsedMs / 1000)}s — likely hung in upload-to-mmg.whatsapp.net`,
      );
    }, 10_000);
    try {
      const r = await withSendTimeout(
        this.socket.sendMessage(jid, content),
        SEND_TIMEOUT_MEDIA_MS,
        kind,
      );
      sharedLogger.info(
        { jid, kind, bytes, elapsedMs: Date.now() - t0 },
        'whatsapp-personal: media send OK',
      );
      return r?.key?.id;
    } catch (err) {
      sharedLogger.error(
        {
          jid,
          kind,
          bytes,
          elapsedMs: Date.now() - t0,
          err: err instanceof Error ? err.message : String(err),
        },
        'whatsapp-personal: media send FAILED',
      );
      throw err;
    } finally {
      clearInterval(heartbeat);
    }
  }

  /**
   * Pre-flight: fail fast when the socket isn't `connected`. Baileys
   * will otherwise queue the message internally and let it hang for
   * 60-80s before its own internal timeout fires — exactly the failure
   * mode we hit on 2026-05-17 (PDF send → 80s wait → "Timed Out" with
   * no actionable error). With this check, the agent gets a clear
   * `whatsapp-personal: connection not open (status=connecting)` in
   * <10ms and can retry / use a different channel.
   */
  private assertConnectedForSend(kind: string): void {
    if (this.status !== 'connected') {
      throw new Error(
        `whatsapp-personal: cannot send ${kind} — connection not open (status=${this.status}). ` +
          'WhatsApp Web may be reconnecting; retry in a few seconds or use a different channel.',
      );
    }
  }

  /**
   * Phase 10A — accessor for the bot's own JID (set once Baileys
   * reports `connection: 'open'`). Returns null pre-connect or after
   * a clean stop. The mention-detection logic in `inbound-normaliser`
   * uses this to spot @-mentions of the operator's own number.
   */
  getOwnJid(): string | null {
    return this.socket?.user?.id ?? null;
  }

  /**
   * Decrypts and downloads media bytes for an inbound `messageMessage`
   * (image / video / audio / document / sticker). Returns `null` on any
   * failure — Baileys' decrypt path can throw on expired media URLs,
   * partial fetches, network blips, etc. Callers (currently the plugin's
   * inbound handler) just leave the attachment metadata-only when this
   * returns null so the rest of the flow still proceeds.
   *
   * WhatsApp media is E2E-encrypted; a plain HTTP GET against the
   * Baileys-reported URL returns ciphertext. This wraps the official
   * `downloadMediaMessage` helper so the bridge can persist real bytes
   * to `<workspace>/.attachments/<turnId>/` and the agent's hint then
   * tells it to call `analyze_image` / `read_file` with that path
   * instead of chasing a phantom file.
   */
  async downloadMedia(msg: BaileysWAMessage): Promise<Buffer | null> {
    if (!this.socket) return null;
    try {
      const mod = await loadBaileys();
      if (!mod.downloadMediaMessage) return null;
      const buf = await mod.downloadMediaMessage(msg, 'buffer', {});
      return Buffer.isBuffer(buf) ? buf : null;
    } catch (err) {
      sharedLogger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'whatsapp-personal: downloadMedia failed (non-fatal)',
      );
      return null;
    }
  }

  /** Mark messages as read on the operator's phone. */
  async markRead(keys: Array<BaileysWAMessage['key']>): Promise<void> {
    if (!this.socket?.readMessages) return;
    try {
      await this.socket.readMessages(keys);
    } catch (err) {
      sharedLogger.debug(
        { err: err instanceof Error ? err.message : String(err) },
        'whatsapp-personal: markRead failed (non-fatal)',
      );
    }
  }

  /** Toggle the typing indicator. */
  async setTyping(jid: string, on: boolean): Promise<void> {
    if (!this.socket?.sendPresenceUpdate) return;
    try {
      await this.socket.sendPresenceUpdate(on ? 'composing' : 'paused', jid);
    } catch (err) {
      sharedLogger.debug(
        { err: err instanceof Error ? err.message : String(err) },
        'whatsapp-personal: setTyping failed (non-fatal)',
      );
    }
  }

  /** Close the connection and stop all reconnect attempts. Idempotent. */
  async stop(): Promise<void> {
    this.stopRequested = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      try {
        if (this.socket.end) await this.socket.end(undefined);
        else this.socket.ws?.close?.();
      } catch (err) {
        sharedLogger.debug(
          { err: err instanceof Error ? err.message : String(err) },
          'whatsapp-personal: socket end threw (ignored)',
        );
      }
      this.socket = null;
    }
    // Phase 10A — release the session-dir lock. Idempotent — release()
    // no-ops on a second call. Best-effort: a release failure must not
    // prevent process shutdown.
    if (this.lockHandle) {
      try {
        this.lockHandle.release();
      } catch (err) {
        sharedLogger.debug(
          { err: err instanceof Error ? err.message : String(err) },
          'whatsapp-personal: lock release threw (ignored)',
        );
      }
      this.lockHandle = null;
    }
    this.setStatus('idle');
  }

  // ---- internals -------------------------------------------------------

  private handleConnectionUpdate(update: BaileysConnectionUpdate): void {
    if (update.qr) {
      this.setStatus('qr');
      this.emit('qr', update.qr);
    }

    if (update.connection === 'connecting') {
      this.setStatus('connecting');
      this.emit('connecting');
    }

    if (update.connection === 'open') {
      this.consecutiveFailures = 0;
      this.hasOpened = true;
      const userId = this.socket?.user?.id ?? '';
      this.phoneNumber = extractPhoneFromJid(userId);
      this.setStatus('connected');
      this.emit('connected', { phoneNumber: this.phoneNumber ?? userId });
    }

    if (update.connection === 'close') {
      const err = update.lastDisconnect?.error;
      const statusCode = readStatusCode(err);
      const detail = readErrorMessage(err);

      // 401 / 403 → session expired (user logged out from phone, or
      // Meta blacklisted the device). No point reconnecting.
      if (statusCode === 401 || statusCode === 403) {
        this.setStatus('session-expired');
        this.emit('session-expired', { statusCode, detail });
        this.emit('disconnected', { reason: 'logged-out', statusCode, detail });
        return;
      }

      // Close arrived before we ever reached `open` — WhatsApp rejected
      // the handshake outright (commonly 405 "Connection Failure" =
      // outdated client version, or 515 "stream errored"). Reconnecting
      // would just hit the same rejection again. Emit a terminal event
      // so the pair-ui flow can surface it to the operator instead of
      // spinning forever.
      if (!this.hasOpened) {
        this.setStatus('session-down');
        this.emit('handshake-rejected', { statusCode, detail });
        this.emit('disconnected', { reason: 'transient', statusCode, detail });
        return;
      }

      this.emit('disconnected', { reason: 'transient', statusCode, detail });

      if (this.stopRequested) {
        // Cooperative shutdown — don't reconnect.
        this.setStatus('idle');
        return;
      }

      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures > this.config.reconnectMaxAttempts) {
      this.setStatus('session-down');
      this.emit('session-down', { attempts: this.consecutiveFailures });
      return;
    }
    const exp = Math.min(
      this.config.reconnectBaseBackoffMs * Math.pow(2, this.consecutiveFailures - 1),
      this.config.reconnectMaxBackoffMs,
    );
    // ±20% jitter to avoid thundering herd.
    const jitter = exp * (0.8 + Math.random() * 0.4);
    const delayMs = Math.round(jitter);
    this.setStatus('reconnecting');
    this.emit('reconnecting', { attempt: this.consecutiveFailures, delayMs });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopRequested) return;
      this.start().catch((err) => this.emit('error', err instanceof Error ? err : new Error(String(err))));
    }, delayMs);
  }

  private handleMessage(msg: BaileysWAMessage): void {
    // Skip our own outbound echoes (`fromMe`) and protocol messages
    // without content — the plugin's normaliser also filters but we
    // short-circuit here to avoid waking up subscribers needlessly.
    if (!msg?.key) return;
    if (msg.key.fromMe) return;
    if (!msg.message) return;
    this.emit('message', msg);
  }

  private setStatus(s: WhatsAppConnectionStatus): void {
    this.status = s;
  }
}

/** Extract a phone number from a Baileys user JID like `628123:0@s.whatsapp.net`. */
export function extractPhoneFromJid(jid: string): string | null {
  if (!jid) return null;
  const head = jid.split('@')[0] ?? '';
  const num = head.split(':')[0] ?? '';
  if (!num) return null;
  return num.startsWith('+') ? num : '+' + num;
}

function readStatusCode(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const e = err as { output?: { statusCode?: number } };
  return e.output?.statusCode;
}

function readErrorMessage(err: unknown): string | undefined {
  if (!err) return undefined;
  if (err instanceof Error) return err.message;
  if (typeof err === 'object') {
    const e = err as { message?: string };
    return e.message;
  }
  return undefined;
}

/**
 * Default adapter — lazy-imports Baileys. Throws a friendly error if
 * the peer dependency is missing.
 */
export function defaultBaileysAdapter(): BaileysAdapter {
  return {
    async loadAuthState(sessionDir: string) {
      const baileys = await loadBaileys();
      const { state, saveCreds } = await baileys.useMultiFileAuthState(sessionDir);
      return { state, saveCreds };
    },
    makeSocket(args) {
      // Baileys' default export is `makeWASocket`. Cast through
      // `unknown` because Baileys' types are heavyweight and the
      // structural interface above is what we actually consume.
      const mod = loadBaileysSync();
      const sock = mod.makeWASocket({
        auth: args.auth,
        logger: args.logger,
        printQRInTerminal: args.printQRInTerminal ?? false,
        version: mod.version,
        // Baileys ≥6 deprecates `printQRInTerminal`; we keep both for
        // version tolerance — the option is ignored when unsupported.
      } as unknown as Parameters<BaileysModuleShape['makeWASocket']>[0]);
      return sock;
    },
  };
}

// Lazy + sync caches for Baileys — the default adapter resolves once
// per process and reuses the resolved module.
let baileysModule: BaileysModuleShape | null = null;

interface BaileysModuleShape {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  makeWASocket: (opts: any) => BaileysSocketHandle;
  useMultiFileAuthState(dir: string): Promise<{
    state: unknown;
    saveCreds: () => Promise<void>;
  }>;
  /**
   * Decrypts + downloads media bytes for an inbound WAMessage. WhatsApp
   * media is E2E-encrypted, so the bytes can't be fetched with a plain
   * HTTP GET — Baileys handles the key derivation and decryption. Used
   * by `WhatsAppBaileysClient.downloadMedia` so the bridge can persist
   * inbound images / documents to `<workspace>/.attachments/` and the
   * agent can hand them to `analyze_image` / `read_file`.
   */
  downloadMediaMessage(
    msg: BaileysWAMessage,
    type: 'buffer',
    options: Record<string, unknown>,
    ctx?: { logger?: unknown; reuploadRequest?: unknown },
  ): Promise<Buffer>;
  /**
   * Live WhatsApp-Web protocol version. Resolved once per process via
   * `fetchLatestBaileysVersion()` at module load; the cached value is
   * passed to `makeWASocket` so Meta accepts the handshake. Without
   * this the bundled-in default version goes stale roughly monthly and
   * WhatsApp closes the WS with status 405 ("Connection Failure"),
   * which silently loops the wrapper's reconnect ladder.
   */
  version: readonly [number, number, number];
}

async function loadBaileys(): Promise<BaileysModuleShape> {
  if (baileysModule) return baileysModule;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = (await import('@whiskeysockets/baileys')) as any;
    // Resolve the live WA-web version Meta currently accepts. If the
    // helper itself errors (no network, GitHub Pages flake) we fall
    // back to Baileys' bundled default — that may 405 but the
    // dashboard now surfaces the close to the operator instead of
    // hanging forever.
    let version: readonly [number, number, number];
    try {
      const r = (await mod.fetchLatestBaileysVersion()) as {
        version: [number, number, number];
        isLatest: boolean;
      };
      version = r.version;
    } catch (err) {
      sharedLogger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'whatsapp-personal: fetchLatestBaileysVersion failed; using bundled default',
      );
      version = [2, 3000, 0] as const;
    }
    baileysModule = {
      // Baileys exports `makeWASocket` as default export and named.
      makeWASocket: mod.default ?? mod.makeWASocket,
      useMultiFileAuthState: mod.useMultiFileAuthState,
      downloadMediaMessage: mod.downloadMediaMessage,
      version,
    };
    return baileysModule;
  } catch (err) {
    throw new Error(
      'whatsapp-personal: @whiskeysockets/baileys is not installed. ' +
        'Run `pnpm add @whiskeysockets/baileys qrcode-terminal pino` in the ' +
        'consuming app, or set the channel mode to `cloud` in vault.json.\n' +
        `Original error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function loadBaileysSync(): BaileysModuleShape {
  if (!baileysModule) {
    throw new Error(
      'whatsapp-personal: Baileys not preloaded — call loadBaileys() first',
    );
  }
  return baileysModule;
}

/**
 * Construct a sensible default logger for Baileys.
 *
 * Phase 10A — when `config.useRealPino` is set, attempt a synchronous
 * `require('pino')` (works for the CommonJS build of pino) so the full
 * library lands in Baileys. When pino isn't installed (it's an
 * optional peer dep) we fall back to the structural no-op and emit a
 * single warn so the operator knows the flag had no effect. Default
 * (`useRealPino` unset/false) keeps the cheap noop path.
 */
function defaultBaileysLogger(config: WhatsAppPersonalConfig): unknown {
  const opt = config.useRealPino;
  if (opt) {
    const level =
      typeof opt === 'object' && opt && 'level' in opt && opt.level
        ? opt.level
        : 'info';
    try {
      const pino = loadPinoSync();
      if (pino) {
        return pino({ level });
      }
      sharedLogger.warn(
        'whatsapp-personal: useRealPino requested but `pino` is not installed; falling back to noop logger',
      );
    } catch (err) {
      sharedLogger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'whatsapp-personal: pino load failed; falling back to noop logger',
      );
    }
  }
  return makeNoopLogger(config.logLevel);
}

function makeNoopLogger(_level: WhatsAppPersonalConfig['logLevel']): unknown {
  const noop = (): void => {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lg: any = {
    level: _level,
    fatal: noop,
    error: noop,
    warn: noop,
    info: noop,
    debug: noop,
    trace: noop,
    child: () => lg,
  };
  return lg;
}

/**
 * Synchronously load pino via `createRequire` so the constructor stays
 * sync. Returns `null` when pino isn't installed — caller falls back
 * to the noop logger.
 */
function loadPinoSync(): ((opts: { level: string }) => unknown) | null {
  try {
    // Use createRequire to avoid `require` not being defined in ESM,
    // and to keep this resolution local to whichever consumer
    // installed pino. Top-level dynamic import would force this method
    // to be async.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createRequire } = require('node:module') as typeof import('node:module');
    const req = createRequire(import.meta.url);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = req('pino') as any;
    // pino exports a default factory in CJS and a named one in ESM.
    return (mod.default ?? mod) as (opts: { level: string }) => unknown;
  } catch {
    return null;
  }
}
