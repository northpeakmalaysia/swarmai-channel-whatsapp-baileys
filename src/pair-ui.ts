import { BaileysClient, type BaileysAdapter } from './baileys-client.js';
import { WhatsAppPersonalConfigSchema, type WhatsAppPersonalConfig } from './types.js';

/**
 * UI-driven pair flow for WhatsApp Personal — emitter-based variant of
 * `runPairFlow` (pair-flow.ts) for browser-side pairing in the dashboard.
 *
 * The CLI flow drives a synchronous QR-on-stderr → readline 2FA loop.
 * The dashboard variant reverses the polarity: every state transition
 * is emitted as a `PairEvent`, the dashboard's modal state-machine
 * reacts to those events, and 2FA submission flows back via the
 * controller's `submit2fa()` rather than a stdin readline.
 *
 * WhatsApp's Baileys layer doesn't have a 2FA cloud password concept
 * (the QR scan IS the auth). The 2FA-related events are reserved on
 * the union for symmetry with the Telegram flow — they are never
 * emitted for WhatsApp. Keeping the union shared simplifies the
 * dashboard reducer (one event type for both adapters).
 *
 * Lifecycle:
 *   start ──► emit('qr-ready', { qrPayload, expiresAt })   (one or more
 *                                                           — Baileys
 *                                                           rotates the
 *                                                           QR every ~60s)
 *           ──► emit('scanned')                            (on
 *                                                          `connection: open`
 *                                                          before phone
 *                                                          number is
 *                                                          resolved)
 *           ──► emit('success', { username, sessionString }) (terminal)
 *           ──► emit('error',  { code, message })            (terminal)
 *           ──► emit('cancelled')                            (terminal,
 *                                                            via `cancel()`)
 *
 * Single-shot: each call to `runWhatsAppPersonalPairForUi` instantiates
 * a fresh client, drives it to terminal, and returns. Re-pair = call
 * again.
 */

export type PairEvent =
  | {
      kind: 'qr-ready';
      /** Raw QR payload — caller renders to SVG/canvas in the browser. */
      qrPayload: string;
      /** ISO-8601 expiry — the QR rotates roughly every 60 s. */
      expiresAt: string;
    }
  | { kind: 'scanned' }
  | { kind: 'need-2fa' }
  | {
      kind: 'success';
      /** Public account identifier (`username` for Telegram, phone for WA). */
      username: string;
      /**
       * Persisted session payload. For WhatsApp this is the resolved
       * phone number (the actual creds live in the on-disk session
       * dir referenced by `sessionDir` in the result envelope below).
       * For Telegram this is the gram.js StringSession.
       */
      sessionString: string;
    }
  | { kind: 'error'; code: string; message: string }
  | { kind: 'cancelled' };

export interface PairEventEmitter {
  /** Fire a state event. Implementations MUST be non-throwing. */
  onEvent(event: PairEvent): void;
}

export interface WhatsAppPairUiResult {
  username: string;
  sessionString: string;
  /** Resolved Baileys session dir (vault-side persistence reference). */
  sessionDir: string;
}

export interface WhatsAppPairUiOptions {
  /** Partial config — `sessionId` defaults to `pending-pair`. */
  config?: Partial<WhatsAppPersonalConfig> & { sessionId?: string };
  /** Inject an adapter (tests). */
  adapter?: BaileysAdapter;
  /** Fired on every state transition. */
  emitter: PairEventEmitter;
  /** External cancel signal — when aborted, the flow emits `cancelled`. */
  signal?: AbortSignal;
  /** Per-QR TTL in ms (default 60_000 — Baileys rotates QRs at ~60s). */
  qrTtlMs?: number;
  /** Overall timeout (default 5 min — long enough for a real pair). */
  timeoutMs?: number;
}

export interface PairController<TResult> {
  /** Resolves once the flow terminates. Rejects only on programmer error. */
  promise: Promise<TResult>;
  /** Submit a 2FA cloud password (Telegram only — no-op for WhatsApp). */
  submit2fa(password: string): void;
  /** Abort the flow. Idempotent. */
  cancel(): void;
}

/**
 * Map a WhatsApp-Web WS close `statusCode` (carried by Baileys'
 * `lastDisconnect.error.output.statusCode`) into an operator-facing
 * `{ code, message }` pair routed through the `error` PairEvent.
 *
 * The dashboard's `humanCode()` switch in `PairChannelDialog.tsx`
 * renders these codes as short headers (e.g. `pair-failed-outdated` →
 * "Pair failed"). Keep the code strings stable so the dialog can grow
 * specific copy per code over time.
 *
 * Status codes seen so far in the wild:
 *   - 405 — "Connection Failure". Baileys' bundled WA-web version
 *           is stale; Meta rotates the accepted version roughly monthly.
 *           Fix: server picks the live version via `fetchLatestBaileysVersion()`,
 *           but if THAT helper also failed at boot we still 405 here.
 *   - 408 — request timeout (Baileys couldn't handshake in time).
 *   - 428 — connection terminated by server (rare; usually region blocks).
 *   - 500 — internal stream error.
 *   - 515 — "stream errored" (Baileys saw a malformed protocol frame).
 *   - 440 — replaced (another linked-device pair stole the session).
 *   - undefined — close arrived with no statusCode (transport-level
 *                 reset before Noise; usually a proxy or firewall).
 *
 * TODO (operator-facing copy) — see the call in `runWhatsAppPersonalPairForUi`.
 */
function mapHandshakeReject(
  statusCode: number | undefined,
  detail: string | undefined,
): { code: string; message: string } {
  // PLACEHOLDER — replaced by the operator's mapping. The default below
  // is a single catch-all so a fresh check-in still compiles.
  return {
    code: 'wa-handshake-rejected',
    message: `WhatsApp closed the connection (status ${statusCode ?? '?'}): ${detail ?? 'no detail'}`,
  };
}

/**
 * Drive the WhatsApp Personal QR pair flow with browser-friendly events.
 *
 * The returned controller's `promise` resolves with the final result
 * envelope. The emitter receives every state transition; `submit2fa`
 * is a no-op (Baileys doesn't have 2FA — kept for shape parity).
 */
export function runWhatsAppPersonalPairForUi(
  opts: WhatsAppPairUiOptions,
): PairController<WhatsAppPairUiResult> {
  const config = WhatsAppPersonalConfigSchema.parse({
    sessionId: opts.config?.sessionId ?? 'pending-pair',
    ...opts.config,
  });
  const qrTtlMs = opts.qrTtlMs ?? 60_000;
  const timeoutMs = opts.timeoutMs ?? 300_000; // 5 min absolute cap.

  const client = new BaileysClient({
    config,
    ...(opts.adapter ? { adapter: opts.adapter } : {}),
  });

  let resolved = false;
  let cancelled = false;

  // Promise wrapping the controller — `finish` resolves it, `fail`
  // rejects it; both detach listeners and stop the underlying socket
  // exactly once.
  let resolveOuter!: (r: WhatsAppPairUiResult) => void;
  let rejectOuter!: (err: Error) => void;
  const outer = new Promise<WhatsAppPairUiResult>((res, rej) => {
    resolveOuter = res;
    rejectOuter = rej;
  });

  let timeoutHandle: NodeJS.Timeout | null = null;
  const safeEmit = (ev: PairEvent): void => {
    try {
      opts.emitter.onEvent(ev);
    } catch {
      /* the emitter must never break the flow */
    }
  };

  const cleanup = (): void => {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
    client.removeAllListeners('qr');
    client.removeAllListeners('connected');
    client.removeAllListeners('session-expired');
    client.removeAllListeners('handshake-rejected');
    client.removeAllListeners('error');
    void client.stop().catch(() => {
      /* best-effort — operator already saw the terminal event */
    });
  };

  const finish = (result: WhatsAppPairUiResult): void => {
    if (resolved) return;
    resolved = true;
    cleanup();
    safeEmit({
      kind: 'success',
      username: result.username,
      sessionString: result.sessionString,
    });
    resolveOuter(result);
  };

  const fail = (code: string, message: string): void => {
    if (resolved) return;
    resolved = true;
    cleanup();
    if (cancelled) {
      safeEmit({ kind: 'cancelled' });
    } else {
      safeEmit({ kind: 'error', code, message });
    }
    // Reject so `await controller.promise` callers can react to errors,
    // but the dashboard primarily reacts to the emitter — both are
    // first-class.
    rejectOuter(new Error(`${code}: ${message}`));
  };

  // Wire up the underlying client.
  client.on('qr', (qr: string) => {
    safeEmit({
      kind: 'qr-ready',
      qrPayload: qr,
      expiresAt: new Date(Date.now() + qrTtlMs).toISOString(),
    });
  });

  client.on(
    'connected',
    ({ phoneNumber }: { phoneNumber: string | null }) => {
      // Baileys jumps from `qr` → `connected` directly when the operator
      // scans. Emit `scanned` first so the modal can transition out of
      // the QR display before the success toast lands.
      safeEmit({ kind: 'scanned' });
      const phone = phoneNumber ?? 'unknown';
      const sessionDir = client.getSessionDir() ?? '';
      finish({
        username: phone,
        sessionString: phone, // WA persists creds on disk under sessionDir.
        sessionDir,
      });
    },
  );

  client.on(
    'session-expired',
    ({
      statusCode,
      detail,
    }: {
      statusCode?: number;
      detail?: string;
    }) => {
      fail(
        'session-expired',
        `pairing rejected (status ${statusCode ?? '?'}): ${detail ?? 'phone may have logged this device out'}`,
      );
    },
  );

  // WhatsApp closed the socket before we ever reached `open` — the
  // wrapper's pair-phase guard. Map the WS status code to an
  // operator-facing PairEvent error code via `mapHandshakeReject`
  // (below) so the dashboard renders something actionable instead of
  // "stream-failed: HTTP -1".
  client.on(
    'handshake-rejected',
    ({
      statusCode,
      detail,
    }: {
      statusCode?: number;
      detail?: string;
    }) => {
      const mapped = mapHandshakeReject(statusCode, detail);
      fail(mapped.code, mapped.message);
    },
  );

  client.on('error', (err: unknown) => {
    fail('client-error', err instanceof Error ? err.message : String(err));
  });

  // Overall timeout — generous since the operator may take time to find
  // their phone. Per-QR rotation is handled inside Baileys; we re-emit
  // `qr-ready` whenever Baileys mints a new token.
  timeoutHandle = setTimeout(() => {
    fail(
      'timeout',
      `pairing timed out after ${Math.round(timeoutMs / 1000)}s — re-open the modal to retry`,
    );
  }, timeoutMs);

  // External cancel.
  if (opts.signal) {
    if (opts.signal.aborted) {
      cancelled = true;
      // Defer so the caller has a chance to attach `.then` first.
      queueMicrotask(() => fail('cancelled', 'aborted before start'));
    } else {
      opts.signal.addEventListener(
        'abort',
        () => {
          cancelled = true;
          fail('cancelled', 'aborted by caller');
        },
        { once: true },
      );
    }
  }

  // Kick off the connection.
  client.start().catch((err) => {
    fail(
      'start-failed',
      err instanceof Error ? err.message : String(err),
    );
  });

  return {
    promise: outer,
    submit2fa(_password: string): void {
      // No-op — Baileys/WhatsApp doesn't have a separate 2FA step.
      // The function exists for shape parity with the Telegram flow
      // so the dashboard's controller doesn't need to branch.
    },
    cancel(): void {
      if (resolved) return;
      cancelled = true;
      fail('cancelled', 'cancelled by user');
    },
  };
}
