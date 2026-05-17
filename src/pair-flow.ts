import { BaileysClient, type BaileysAdapter } from './baileys-client.js';
import { renderQr } from './qr-display.js';
import { WhatsAppPersonalConfigSchema, type WhatsAppPersonalConfig } from './types.js';

/**
 * Pair-flow orchestrator — drives the QR loop until the operator
 * scans with their phone or the timeout elapses.
 *
 * Used by:
 *   - `apps/cli/src/setup-flow/whatsapp-pair.ts` (interactive setup)
 *   - any future re-pair tool (`swarmai whatsapp repair`).
 *
 * The flow is one-shot: each call instantiates a fresh client, drives
 * it to `connected`, and stops it. Callers that want a persistent
 * channel use the plugin (`createWhatsAppPersonalPlugin`) directly.
 */

export interface PairFlowOptions {
  /** Partial config — `sessionId` is required, others default. */
  config: Partial<WhatsAppPersonalConfig> & { sessionId?: string };
  /** Inject an adapter (tests). */
  adapter?: BaileysAdapter;
  /** Override QR rendering (tests). Default writes ASCII to stderr. */
  onQr?: (qr: string) => void | Promise<void>;
  /** Override info logging. Default writes a few lines to stderr. */
  onInfo?: (msg: string) => void;
  /** Pairing timeout in ms (default 60_000 — Baileys QRs rotate every ~60s). */
  timeoutMs?: number;
}

export interface PairFlowResult {
  /** Phone number of the linked device (digits-only or '+digits'). */
  phoneNumber: string;
  /** Resolved session directory — vault should persist this. */
  sessionDir: string;
  /** Resolved session id (the sanitised phone number). */
  sessionId: string;
}

/**
 * Run the pair flow. Resolves on `connected`; rejects on timeout or
 * fatal error. Always cleans up the underlying socket — caller does
 * not need to call `client.stop()`.
 */
export async function runPairFlow(opts: PairFlowOptions): Promise<PairFlowResult> {
  // Use a placeholder sessionId for the first scan — Baileys writes
  // its creds + identity into the dir, and we rename the dir to the
  // resolved phone number once `connected` lands.
  const config = WhatsAppPersonalConfigSchema.parse({
    sessionId: opts.config.sessionId ?? 'pending-pair',
    ...opts.config,
  });

  const info = opts.onInfo ?? defaultInfo;
  const timeoutMs = opts.timeoutMs ?? 60_000;

  const client = new BaileysClient({
    config,
    ...(opts.adapter ? { adapter: opts.adapter } : {}),
  });

  let qrTimeout: NodeJS.Timeout | null = null;
  let resolved = false;

  return new Promise<PairFlowResult>((resolve, reject) => {
    const cleanup = (): void => {
      if (qrTimeout) {
        clearTimeout(qrTimeout);
        qrTimeout = null;
      }
      // Detach listeners so concurrent stops don't trigger them.
      client.removeAllListeners('qr');
      client.removeAllListeners('connected');
      client.removeAllListeners('session-expired');
      client.removeAllListeners('error');
    };

    const finish = (err: Error | null, result: PairFlowResult | null): void => {
      if (resolved) return;
      resolved = true;
      cleanup();
      // Stop the socket asynchronously — don't gate the resolve on it
      // (the operator is staring at a successful "Connected" message).
      void client.stop();
      if (err) reject(err);
      else if (result) resolve(result);
      else reject(new Error('pair flow finished without result'));
    };

    qrTimeout = setTimeout(() => {
      finish(
        new Error(
          `whatsapp-personal: QR pairing timed out after ${timeoutMs}ms — the QR ` +
            'code expired before scanning. Re-run setup to try again.',
        ),
        null,
      );
    }, timeoutMs);

    client.on('qr', async (qr) => {
      try {
        if (opts.onQr) await opts.onQr(qr);
        else await renderQr(qr);
        info('Waiting for you to scan the QR code in WhatsApp...');
      } catch (err) {
        info(
          `(QR render warning: ${err instanceof Error ? err.message : String(err)})`,
        );
      }
    });

    client.on('connected', ({ phoneNumber }: { phoneNumber: string | null }) => {
      const phone = phoneNumber ?? 'unknown';
      const sessionDir = client.getSessionDir() ?? '';
      info(`Connected as ${phone}.`);
      finish(null, {
        phoneNumber: phone,
        sessionDir,
        sessionId: config.sessionId,
      });
    });

    client.on('session-expired', ({ statusCode, detail }: { statusCode?: number; detail?: string }) => {
      finish(
        new Error(
          `whatsapp-personal: pairing rejected (status ${statusCode ?? '?'}). ` +
            (detail ?? 'The phone may have logged this device out, ' +
              'or 2FA may be enabled and the verification step failed.'),
        ),
        null,
      );
    });

    client.on('error', (err: unknown) => {
      finish(err instanceof Error ? err : new Error(String(err)), null);
    });

    // Kick off the connection. Errors during start fail the promise.
    client.start().catch((err) => {
      finish(err instanceof Error ? err : new Error(String(err)), null);
    });
  });
}

function defaultInfo(msg: string): void {
  // Setup flows direct to stderr — keeps stdout clean for log piping.
  process.stderr.write(msg + '\n');
}
