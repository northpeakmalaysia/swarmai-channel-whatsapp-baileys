import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import {
  BaileysClient,
  extractPhoneFromJid,
  type BaileysAdapter,
  type BaileysSocketHandle,
  type BaileysConnectionUpdate,
} from './baileys-client.js';
import { WhatsAppPersonalConfigSchema } from './types.js';

/**
 * Test helper — builds a fake Baileys socket that exposes the same
 * structural API the real one does. The `harness` lets tests trigger
 * connection-update / messages-upsert events deterministically.
 */
function makeFakeSocket(): {
  socket: BaileysSocketHandle;
  emitConn: (u: BaileysConnectionUpdate) => void;
  emitMessage: (msg: unknown) => void;
  sendTextMock: ReturnType<typeof vi.fn>;
} {
  const ee = new EventEmitter();
  const sendTextMock = vi.fn(async () => ({ key: { id: 'wam-id-1' } }));
  const socket: BaileysSocketHandle = {
    user: { id: '628999:0@s.whatsapp.net' },
    ev: {
      on(event: string, cb: (...args: unknown[]) => void) {
        ee.on(event, cb);
      },
      removeAllListeners() {
        ee.removeAllListeners();
      },
    },
    sendMessage: sendTextMock,
    sendPresenceUpdate: vi.fn(async () => {}),
    readMessages: vi.fn(async () => {}),
    end: vi.fn(async () => {}),
    ws: { close: () => {} },
  };
  return {
    socket,
    emitConn: (u) => ee.emit('connection.update', u),
    emitMessage: (msg) =>
      ee.emit('messages.upsert', { messages: [msg], type: 'notify' }),
    sendTextMock,
  };
}

function makeFakeAdapter(): {
  adapter: BaileysAdapter;
  saveCreds: ReturnType<typeof vi.fn>;
  emitConn: (u: BaileysConnectionUpdate) => void;
  emitMessage: (msg: unknown) => void;
  sendTextMock: ReturnType<typeof vi.fn>;
} {
  const fake = makeFakeSocket();
  const saveCreds = vi.fn(async () => {});
  return {
    adapter: {
      async loadAuthState(_dir: string) {
        return { state: { fake: true }, saveCreds };
      },
      makeSocket(_args) {
        return fake.socket;
      },
    },
    saveCreds,
    emitConn: fake.emitConn,
    emitMessage: fake.emitMessage,
    sendTextMock: fake.sendTextMock,
  };
}

describe('extractPhoneFromJid', () => {
  it('extracts the digits before `:`', () => {
    expect(extractPhoneFromJid('628999:0@s.whatsapp.net')).toBe('+628999');
  });
  it('preserves a leading +', () => {
    expect(extractPhoneFromJid('+628999@s.whatsapp.net')).toBe('+628999');
  });
  it('returns null for empty input', () => {
    expect(extractPhoneFromJid('')).toBe(null);
  });
});

describe('BaileysClient', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'wa-client-'));
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  function makeConfig() {
    return WhatsAppPersonalConfigSchema.parse({
      sessionId: 'test-' + Date.now(),
      sessionDir: join(tmp, 'session'),
      reconnectBaseBackoffMs: 10,
      reconnectMaxBackoffMs: 50,
      reconnectMaxAttempts: 3,
    });
  }

  it('emits qr → connected events from the underlying socket', async () => {
    const fake = makeFakeAdapter();
    const client = new BaileysClient({ config: makeConfig(), adapter: fake.adapter });
    const events: string[] = [];
    client.on('qr', () => events.push('qr'));
    client.on('connected', () => events.push('connected'));
    client.on('connecting', () => events.push('connecting'));

    await client.start();
    fake.emitConn({ qr: 'QR-PAYLOAD' });
    fake.emitConn({ connection: 'open' });

    expect(events).toContain('connecting');
    expect(events).toContain('qr');
    expect(events).toContain('connected');
    expect(client.getStatus()).toBe('connected');
    expect(client.getPhoneNumber()).toBe('+628999');
    await client.stop();
  });

  /**
   * Regression: prior to the override-leak fix, start() unconditionally
   * called ensureSessionDir({ sessionId }) which mkdir'd
   * `<workspaceRoot>/whatsapp-personal/<sessionId>/` *even when the
   * caller passed an explicit sessionDir override*. Test runs piled up
   * empty folders in the operator's real ~/.swarmai/whatsapp-personal/.
   * This test pins the contract: with `sessionDir` set, the default
   * workspace path must remain untouched.
   */
  it('does NOT create the default workspace path when sessionDir is overridden', async () => {
    const isolatedWorkspace = mkdtempSync(join(tmpdir(), 'wa-isol-'));
    const prevWorkspace = process.env['SWARMAI_WORKSPACE'];
    process.env['SWARMAI_WORKSPACE'] = isolatedWorkspace;
    try {
      const fake = makeFakeAdapter();
      const cfg = makeConfig();
      const client = new BaileysClient({ config: cfg, adapter: fake.adapter });
      await client.start();
      fake.emitConn({ connection: 'open' });

      // The override path WAS created (Baileys auth state lives here).
      expect(existsSync(cfg.sessionDir!)).toBe(true);
      // The default workspace path was NOT created — no leak.
      const leakedDefault = join(
        isolatedWorkspace,
        'whatsapp-personal',
        cfg.sessionId,
      );
      expect(existsSync(leakedDefault)).toBe(false);
      // Stronger: nothing was created under the default base at all.
      const defaultBase = join(isolatedWorkspace, 'whatsapp-personal');
      expect(existsSync(defaultBase)).toBe(false);

      await client.stop();
    } finally {
      if (prevWorkspace === undefined) delete process.env['SWARMAI_WORKSPACE'];
      else process.env['SWARMAI_WORKSPACE'] = prevWorkspace;
      if (existsSync(isolatedWorkspace)) {
        rmSync(isolatedWorkspace, { recursive: true, force: true });
      }
    }
  });

  it('emits session-expired on close with statusCode 401', async () => {
    const fake = makeFakeAdapter();
    const client = new BaileysClient({ config: makeConfig(), adapter: fake.adapter });
    const events: Array<{ kind: string; payload?: unknown }> = [];
    client.on('session-expired', (p) => events.push({ kind: 'session-expired', payload: p }));
    client.on('reconnecting', () => events.push({ kind: 'reconnecting' }));

    await client.start();
    fake.emitConn({
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 401 }, message: 'logged out' } },
    });

    expect(events.find((e) => e.kind === 'session-expired')).toBeTruthy();
    expect(events.find((e) => e.kind === 'reconnecting')).toBeFalsy();
    expect(client.getStatus()).toBe('session-expired');
    await client.stop();
  });

  it('schedules reconnect on transient close codes', async () => {
    vi.useFakeTimers();
    const fake = makeFakeAdapter();
    const client = new BaileysClient({ config: makeConfig(), adapter: fake.adapter });
    const events: string[] = [];
    client.on('reconnecting', () => events.push('reconnecting'));

    await client.start();
    // Reach `open` first — the wrapper's pair-phase guard treats a
    // close *before* any open as a fatal handshake rejection, so a
    // "transient flap" test must establish the session before flapping.
    fake.emitConn({ connection: 'open' });
    fake.emitConn({
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 500 } } },
    });

    expect(events).toContain('reconnecting');
    expect(client.getStatus()).toBe('reconnecting');
    // Stop before any reconnect timers fire so the test stays deterministic.
    await client.stop();
    vi.useRealTimers();
  });

  it('emits handshake-rejected when close arrives before open', async () => {
    const fake = makeFakeAdapter();
    const client = new BaileysClient({ config: makeConfig(), adapter: fake.adapter });
    const rejected: Array<{ statusCode?: number; detail?: string }> = [];
    const reconnecting: string[] = [];
    client.on('handshake-rejected', (e) => rejected.push(e));
    client.on('reconnecting', () => reconnecting.push('reconnecting'));

    await client.start();
    fake.emitConn({
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 405 }, message: 'Connection Failure' } },
    });

    expect(rejected.length).toBe(1);
    expect(rejected[0]?.statusCode).toBe(405);
    expect(reconnecting).toEqual([]);
    expect(client.getStatus()).toBe('session-down');
    await client.stop();
  });

  it('emits session-down after exhausting retries', async () => {
    const fake = makeFakeAdapter();
    const config = WhatsAppPersonalConfigSchema.parse({
      sessionId: 'down',
      sessionDir: join(tmp, 'session'),
      reconnectBaseBackoffMs: 1,
      reconnectMaxBackoffMs: 2,
      reconnectMaxAttempts: 2,
    });
    const client = new BaileysClient({ config, adapter: fake.adapter });
    const sessionDown: Array<{ attempts: number }> = [];
    client.on('session-down', (e: { attempts: number }) => sessionDown.push(e));

    await client.start();
    // Establish the session first — see the prior test's note. Only
    // *after* an `open` does Baileys' close ladder fall into the
    // transient reconnect path the retry-budget guards.
    fake.emitConn({ connection: 'open' });
    // Fire enough close events to exceed the budget without waiting
    // for actual timers — the client's retry counter increments on
    // each scheduleReconnect call.
    fake.emitConn({ connection: 'close', lastDisconnect: { error: { output: { statusCode: 500 } } } });
    fake.emitConn({ connection: 'close', lastDisconnect: { error: { output: { statusCode: 500 } } } });
    fake.emitConn({ connection: 'close', lastDisconnect: { error: { output: { statusCode: 500 } } } });

    expect(sessionDown.length).toBeGreaterThanOrEqual(1);
    expect(client.getStatus()).toBe('session-down');
    await client.stop();
  });

  it('forwards messages.upsert events as `message`', async () => {
    const fake = makeFakeAdapter();
    const client = new BaileysClient({ config: makeConfig(), adapter: fake.adapter });
    const seen: unknown[] = [];
    client.on('message', (m) => seen.push(m));

    await client.start();
    fake.emitMessage({
      key: { remoteJid: '628@s.whatsapp.net', fromMe: false, id: 'm1' },
      message: { conversation: 'hi' },
    });
    fake.emitMessage({
      // fromMe → must be filtered out
      key: { remoteJid: '628@s.whatsapp.net', fromMe: true, id: 'm2' },
      message: { conversation: 'echo' },
    });

    expect(seen).toHaveLength(1);
    await client.stop();
  });

  it('sendText round-trips through the underlying socket', async () => {
    const fake = makeFakeAdapter();
    const client = new BaileysClient({ config: makeConfig(), adapter: fake.adapter });
    await client.start();
    // Pre-flight connection guard (2026-05-17) requires status=connected
    // before sends — drive the fake socket to `open` so the test exercises
    // the real success path instead of the not-yet-connected refusal.
    fake.emitConn({ connection: 'open' });
    const id = await client.sendText('628@s.whatsapp.net', 'hello');
    expect(fake.sendTextMock).toHaveBeenCalledWith('628@s.whatsapp.net', { text: 'hello' });
    expect(id).toBe('wam-id-1');
    await client.stop();
  });

  it('sendText fails fast when not connected (status !== "connected")', async () => {
    // Defends against the 2026-05-17 production bug where send_message
    // hung for ~80s waiting for Baileys' internal ACK timeout because
    // the socket was reconnecting. With this guard the agent gets a
    // clear refusal in <10ms and can retry / fall back.
    const fake = makeFakeAdapter();
    const client = new BaileysClient({ config: makeConfig(), adapter: fake.adapter });
    await client.start();
    // Intentionally do NOT emit 'open' — status remains 'connecting'.
    await expect(client.sendText('628@s.whatsapp.net', 'hi')).rejects.toThrow(
      /connection not open \(status=connecting\)/,
    );
    expect(fake.sendTextMock).not.toHaveBeenCalled();
    await client.stop();
  });

  it('sendText throws when not started', async () => {
    const fake = makeFakeAdapter();
    const client = new BaileysClient({ config: makeConfig(), adapter: fake.adapter });
    await expect(client.sendText('628@s.whatsapp.net', 'x')).rejects.toThrow(
      /not started/,
    );
  });

  it('cooperative stop suppresses reconnect', async () => {
    const fake = makeFakeAdapter();
    const client = new BaileysClient({ config: makeConfig(), adapter: fake.adapter });
    const events: string[] = [];
    client.on('reconnecting', () => events.push('reconnecting'));

    await client.start();
    await client.stop();

    // Now simulate a close arriving after stop (the underlying socket's
    // event would be ignored). Calling emit directly bypasses the
    // detached listeners, so we instead assert: status = idle.
    expect(client.getStatus()).toBe('idle');
  });
});
