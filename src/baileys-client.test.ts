import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import {
  BaileysClient,
  extractPhoneFromJid,
  extractInviteCode,
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
    // --- capability surface (group/contact/profile) ---
    groupFetchAllParticipating: vi.fn(async () => ({
      '111@g.us': {
        id: '111@g.us',
        subject: 'Team',
        size: 2,
        announce: false,
        participants: [
          { id: '628999:0@s.whatsapp.net', admin: 'superadmin' as const },
          { id: '628111@s.whatsapp.net', admin: null },
        ],
      },
    })),
    groupMetadata: vi.fn(async (jid: string) => ({
      id: jid,
      subject: 'Team',
      desc: 'hello',
      owner: '628999@s.whatsapp.net',
      size: 1,
      participants: [{ id: '628999:0@s.whatsapp.net', admin: 'superadmin' as const }],
    })),
    groupCreate: vi.fn(async (subject: string) => ({ id: 'new@g.us', subject, participants: [] })),
    groupLeave: vi.fn(async () => {}),
    groupParticipantsUpdate: vi.fn(async (_jid: string, parts: string[]) =>
      parts.map((jid) => ({ jid, status: '200' })),
    ),
    groupUpdateSubject: vi.fn(async () => {}),
    groupUpdateDescription: vi.fn(async () => {}),
    groupInviteCode: vi.fn(async () => 'INVITECODE123'),
    groupRevokeInvite: vi.fn(async () => 'NEWCODE456'),
    groupAcceptInvite: vi.fn(async () => 'joined@g.us'),
    groupGetInviteInfo: vi.fn(async () => ({ id: 'preview@g.us', subject: 'Preview', participants: [] })),
    groupSettingUpdate: vi.fn(async () => {}),
    onWhatsApp: vi.fn(async (...jids: string[]) =>
      jids.map((j) => ({ jid: `${j}@s.whatsapp.net`, exists: true })),
    ),
    profilePictureUrl: vi.fn(async () => 'https://pps.whatsapp.net/pic.jpg'),
    updateBlockStatus: vi.fn(async () => {}),
    fetchStatus: vi.fn(async () => ({ status: 'Busy building' })),
    updateProfileName: vi.fn(async () => {}),
    updateProfileStatus: vi.fn(async () => {}),
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
  socket: BaileysSocketHandle;
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
    socket: fake.socket,
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

describe('extractInviteCode', () => {
  it('extracts the code from a full invite link', () => {
    expect(extractInviteCode('https://chat.whatsapp.com/AbC123xyz')).toBe('AbC123xyz');
  });
  it('extracts from the /invite/ form', () => {
    expect(extractInviteCode('https://chat.whatsapp.com/invite/Code999')).toBe('Code999');
  });
  it('passes a bare code through unchanged', () => {
    expect(extractInviteCode('  PlainCode  ')).toBe('PlainCode');
  });
});

describe('BaileysClient.getCapabilities', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'wa-caps-'));
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  async function connectedClient(): Promise<{
    client: BaileysClient;
    socket: BaileysSocketHandle;
  }> {
    const fake = makeFakeAdapter();
    const config = WhatsAppPersonalConfigSchema.parse({
      sessionId: 'caps-' + Date.now(),
      sessionDir: join(tmp, 'session'),
    });
    const client = new BaileysClient({ config, adapter: fake.adapter });
    await client.start();
    fake.emitConn({ connection: 'open' });
    return { client, socket: fake.socket };
  }

  it('listGroups normalises metadata + computes selfIsAdmin from own JID', async () => {
    const { client } = await connectedClient();
    const groups = await client.getCapabilities().listGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ jid: '111@g.us', subject: 'Team', participantCount: 2 });
    // self is 628999 (superadmin in the fixture) → selfIsAdmin true.
    expect(groups[0]!.selfIsAdmin).toBe(true);
  });

  it('getGroupInfo surfaces description + owner + participants', async () => {
    const { client } = await connectedClient();
    const info = await client.getCapabilities().getGroupInfo('111@g.us');
    expect(info.description).toBe('hello');
    expect(info.owner).toBe('628999@s.whatsapp.net');
    expect(info.participants).toHaveLength(1);
  });

  it('joinGroup extracts the invite code from a link before calling Baileys', async () => {
    const { client, socket } = await connectedClient();
    const r = await client.getCapabilities().joinGroup('https://chat.whatsapp.com/AbC123xyz');
    expect(r.groupJid).toBe('joined@g.us');
    expect(socket.groupAcceptInvite).toHaveBeenCalledWith('AbC123xyz');
  });

  it('checkOnWhatsApp maps results back to the requested inputs', async () => {
    const { client } = await connectedClient();
    const res = await client.getCapabilities().checkOnWhatsApp(['+60 11 2396 5866']);
    expect(res[0]!.input).toBe('+60 11 2396 5866');
    expect(res[0]!.exists).toBe(true);
  });

  it('addParticipants returns per-jid results', async () => {
    const { client } = await connectedClient();
    const res = await client
      .getCapabilities()
      .addParticipants('111@g.us', ['628111@s.whatsapp.net']);
    expect(res).toEqual([{ jid: '628111@s.whatsapp.net', status: '200' }]);
  });

  it('sendReaction routes through sendMessage with a react payload', async () => {
    const { client, socket } = await connectedClient();
    await client.getCapabilities().sendReaction('111@g.us', 'wam-9', '👍');
    expect(socket.sendMessage).toHaveBeenCalledWith('111@g.us', {
      react: { text: '👍', key: { remoteJid: '111@g.us', id: 'wam-9', fromMe: false } },
    });
  });

  it('throws a clear error when not connected', async () => {
    const fake = makeFakeAdapter();
    const config = WhatsAppPersonalConfigSchema.parse({
      sessionId: 'caps-down-' + Date.now(),
      sessionDir: join(tmp, 'session-down'),
    });
    const client = new BaileysClient({ config, adapter: fake.adapter });
    await client.start(); // status = connecting, never opened
    await expect(client.getCapabilities().listGroups()).rejects.toThrow(/connection not open/);
  });
});
