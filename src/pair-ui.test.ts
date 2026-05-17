import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { runWhatsAppPersonalPairForUi, type PairEvent } from './pair-ui.js';
import type {
  BaileysAdapter,
  BaileysSocketHandle,
  BaileysConnectionUpdate,
} from './baileys-client.js';

function makeAdapter(): {
  adapter: BaileysAdapter;
  emitConn: (u: BaileysConnectionUpdate) => void;
} {
  const ee = new EventEmitter();
  const socket: BaileysSocketHandle = {
    user: { id: '628111@s.whatsapp.net' },
    ev: {
      on: (event, cb) => ee.on(event, cb),
      removeAllListeners: () => ee.removeAllListeners(),
    },
    sendMessage: async () => ({ key: { id: 'x' } }),
    end: async () => {},
  };
  return {
    adapter: {
      async loadAuthState(_dir) {
        return { state: {}, saveCreds: async () => {} };
      },
      makeSocket(_args) {
        return socket;
      },
    },
    emitConn: (u) => ee.emit('connection.update', u),
  };
}

describe('runWhatsAppPersonalPairForUi', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'wa-pair-ui-'));
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('emits qr-ready → scanned → success on a happy-path scan', async () => {
    const fake = makeAdapter();
    const events: PairEvent[] = [];
    const ctrl = runWhatsAppPersonalPairForUi({
      config: { sessionId: 'happy', sessionDir: join(tmp, 'h') },
      adapter: fake.adapter,
      emitter: { onEvent: (e) => events.push(e) },
      timeoutMs: 5000,
      qrTtlMs: 30_000,
    });

    // Allow listeners to wire.
    await new Promise((r) => setImmediate(r));
    fake.emitConn({ qr: 'WA-QR-PAYLOAD' });
    await new Promise((r) => setImmediate(r));
    fake.emitConn({ connection: 'open' });

    const result = await ctrl.promise;
    expect(result.username).toBe('+628111');
    expect(result.sessionString).toBe('+628111');

    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual(['qr-ready', 'scanned', 'success']);

    const qrEvent = events[0];
    if (qrEvent && qrEvent.kind === 'qr-ready') {
      expect(qrEvent.qrPayload).toBe('WA-QR-PAYLOAD');
      // expiresAt is parseable + in the future.
      const ms = Date.parse(qrEvent.expiresAt);
      expect(Number.isFinite(ms)).toBe(true);
      expect(ms).toBeGreaterThan(Date.now() - 1000);
    } else {
      throw new Error('expected qr-ready first');
    }
  });

  it('emits cancelled when the controller is cancelled mid-flow', async () => {
    const fake = makeAdapter();
    const events: PairEvent[] = [];
    const ctrl = runWhatsAppPersonalPairForUi({
      config: { sessionId: 'cancel', sessionDir: join(tmp, 'c') },
      adapter: fake.adapter,
      emitter: { onEvent: (e) => events.push(e) },
      timeoutMs: 5000,
    });

    await new Promise((r) => setImmediate(r));
    fake.emitConn({ qr: 'TOKEN-A' });
    await new Promise((r) => setImmediate(r));

    ctrl.cancel();
    await expect(ctrl.promise).rejects.toThrow(/cancelled/);

    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain('qr-ready');
    expect(kinds).toContain('cancelled');
    // No success event after cancel.
    expect(kinds).not.toContain('success');
  });

  it('emits error on session-expired (logged-out)', async () => {
    const fake = makeAdapter();
    const events: PairEvent[] = [];
    const ctrl = runWhatsAppPersonalPairForUi({
      config: { sessionId: 'rej', sessionDir: join(tmp, 'r') },
      adapter: fake.adapter,
      emitter: { onEvent: (e) => events.push(e) },
      timeoutMs: 5000,
    });

    await new Promise((r) => setImmediate(r));
    fake.emitConn({
      connection: 'close',
      lastDisconnect: {
        error: { output: { statusCode: 401 }, message: 'logged-out' },
      },
    });
    await expect(ctrl.promise).rejects.toThrow();
    const last = events.at(-1);
    expect(last?.kind).toBe('error');
    if (last?.kind === 'error') {
      expect(last.code).toBe('session-expired');
    }
  });

  it('emits error on timeout', async () => {
    const fake = makeAdapter();
    const events: PairEvent[] = [];
    const ctrl = runWhatsAppPersonalPairForUi({
      config: { sessionId: 'to', sessionDir: join(tmp, 't') },
      adapter: fake.adapter,
      emitter: { onEvent: (e) => events.push(e) },
      timeoutMs: 30,
    });
    await expect(ctrl.promise).rejects.toThrow();
    const last = events.at(-1);
    expect(last?.kind).toBe('error');
    if (last?.kind === 'error') {
      expect(last.code).toBe('timeout');
    }
  });

  it('cancels via AbortSignal', async () => {
    const fake = makeAdapter();
    const events: PairEvent[] = [];
    const ac = new AbortController();
    const ctrl = runWhatsAppPersonalPairForUi({
      config: { sessionId: 'sig', sessionDir: join(tmp, 's') },
      adapter: fake.adapter,
      emitter: { onEvent: (e) => events.push(e) },
      timeoutMs: 5000,
      signal: ac.signal,
    });
    await new Promise((r) => setImmediate(r));
    ac.abort();
    await expect(ctrl.promise).rejects.toThrow();
    expect(events.map((e) => e.kind)).toContain('cancelled');
  });

  it('submit2fa is a no-op for WhatsApp', async () => {
    const fake = makeAdapter();
    const events: PairEvent[] = [];
    const ctrl = runWhatsAppPersonalPairForUi({
      config: { sessionId: 'noop', sessionDir: join(tmp, 'n') },
      adapter: fake.adapter,
      emitter: { onEvent: (e) => events.push(e) },
      timeoutMs: 5000,
    });
    // Calling submit2fa should not throw and should not emit anything.
    expect(() => ctrl.submit2fa('whatever')).not.toThrow();
    ctrl.cancel();
    await expect(ctrl.promise).rejects.toThrow();
  });
});
