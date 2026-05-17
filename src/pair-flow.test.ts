import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { runPairFlow } from './pair-flow.js';
import type { BaileysAdapter, BaileysSocketHandle, BaileysConnectionUpdate } from './baileys-client.js';

function makeAdapter(): {
  adapter: BaileysAdapter;
  emitConn: (u: BaileysConnectionUpdate) => void;
} {
  const ee = new EventEmitter();
  const socket: BaileysSocketHandle = {
    user: { id: '628999@s.whatsapp.net' },
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

describe('pair-flow/runPairFlow', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'wa-pair-'));
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('resolves when the underlying client emits connected', async () => {
    const fake = makeAdapter();
    const onQr = vi.fn();
    const promise = runPairFlow({
      config: { sessionId: 'test-pair', sessionDir: join(tmp, 'p') },
      adapter: fake.adapter,
      onQr,
      onInfo: () => {},
      timeoutMs: 5000,
    });
    // Drive the events on the next tick so the listeners are wired.
    await new Promise((r) => setImmediate(r));
    fake.emitConn({ qr: 'QR-DATA' });
    await new Promise((r) => setImmediate(r));
    fake.emitConn({ connection: 'open' });
    const r = await promise;
    expect(r.phoneNumber).toBe('+628999');
    expect(r.sessionId).toBe('test-pair');
    expect(r.sessionDir).toMatch(/p$/);
    expect(onQr).toHaveBeenCalledWith('QR-DATA');
  });

  it('rejects on timeout', async () => {
    const fake = makeAdapter();
    await expect(
      runPairFlow({
        config: { sessionId: 'timeout', sessionDir: join(tmp, 't') },
        adapter: fake.adapter,
        onInfo: () => {},
        timeoutMs: 30,
      }),
    ).rejects.toThrow(/timed out/);
  });

  it('rejects on session-expired event', async () => {
    const fake = makeAdapter();
    const promise = runPairFlow({
      config: { sessionId: 'rejected', sessionDir: join(tmp, 'r') },
      adapter: fake.adapter,
      onInfo: () => {},
      timeoutMs: 5000,
    });
    await new Promise((r) => setImmediate(r));
    fake.emitConn({
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 401 }, message: '2FA failed' } },
    });
    await expect(promise).rejects.toThrow(/pairing rejected/);
  });
});
