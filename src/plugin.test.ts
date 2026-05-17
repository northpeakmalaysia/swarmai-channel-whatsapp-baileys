import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import {
  createWhatsAppPersonalPlugin,
  createWhatsAppPersonalMonitorSource,
  createWhatsAppPersonalMonitorOnlyBundle,
  MonitorOnlySlotError,
  WHATSAPP_PERSONAL_FEATURES,
  DEFAULT_WHATSAPP_PERSONAL_ID,
} from './plugin.js';
import type { BaileysAdapter, BaileysSocketHandle, BaileysConnectionUpdate } from './baileys-client.js';
import type { InboundEvent } from '@swarmai/plugin-sdk';

function makeAdapter(): {
  adapter: BaileysAdapter;
  emitConn: (u: BaileysConnectionUpdate) => void;
  emitMessage: (msg: unknown) => void;
  sendMock: ReturnType<typeof vi.fn>;
  presenceMock: ReturnType<typeof vi.fn>;
  readMock: ReturnType<typeof vi.fn>;
} {
  const ee = new EventEmitter();
  const sendMock = vi.fn(async () => ({ key: { id: 'wam-1' } }));
  const presenceMock = vi.fn(async () => {});
  const readMock = vi.fn(async () => {});
  const socket: BaileysSocketHandle = {
    user: { id: '628999@s.whatsapp.net' },
    ev: {
      on: (event: string, cb: (...args: unknown[]) => void) => ee.on(event, cb),
      removeAllListeners: () => ee.removeAllListeners(),
    },
    sendMessage: sendMock,
    sendPresenceUpdate: presenceMock,
    readMessages: readMock,
    end: async () => {},
    ws: { close: () => {} },
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
    emitMessage: (msg) => ee.emit('messages.upsert', { messages: [msg], type: 'notify' }),
    sendMock,
    presenceMock,
    readMock,
  };
}

describe('channel-whatsapp-personal/plugin', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'wa-plugin-'));
  });
  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('exports the expected channel + source shape', () => {
    const fake = makeAdapter();
    const b = createWhatsAppPersonalPlugin({ adapter: fake.adapter });
    // Phase 11 — default channel id changed from 'whatsapp' to
    // 'whatsapp-personal' so the bridge can mount Cloud + Personal
    // simultaneously without collision. Per-slot ids
    // ('whatsapp-personal:<slug>') are produced by passing the
    // `channelId` option.
    expect(b.channel.id).toBe('whatsapp-personal');
    expect(b.channel.kind).toBe('both');
    expect(b.channel.defaultDmPolicy).toBe('pairing');
    expect(b.channel.displayName).toMatch(/Personal/);
    expect(b.source.id).toBe('whatsapp-personal');
    expect(b.source.kind).toBe('push');
  });

  it('feature matrix matches WhatsApp Personal expectations', () => {
    expect(WHATSAPP_PERSONAL_FEATURES.dm).toBe(true);
    expect(WHATSAPP_PERSONAL_FEATURES.group).toBe(true);
    expect(WHATSAPP_PERSONAL_FEATURES.typing).toBe(true);
    expect(WHATSAPP_PERSONAL_FEATURES.readReceipt).toBe(true);
  });

  it('healthCheck transitions: down → degraded → ok', async () => {
    const fake = makeAdapter();
    const b = createWhatsAppPersonalPlugin({ adapter: fake.adapter });
    expect((await b.channel.healthCheck()).status).toBe('down');

    await b.channel.start({ config: { sessionDir: join(tmp, 's') }, secrets: {} }, async () => {});
    expect((await b.channel.healthCheck()).status).toBe('degraded'); // connecting

    fake.emitConn({ connection: 'open' });
    expect((await b.channel.healthCheck()).status).toBe('ok');

    await b.channel.stop();
  });

  it('forwards inbound messages to the channel emit + onEvent', async () => {
    const fake = makeAdapter();
    const onEvent: InboundEvent[] = [];
    const channelEmits: InboundEvent[] = [];
    const b = createWhatsAppPersonalPlugin({
      adapter: fake.adapter,
      onEvent: (e) => onEvent.push(e),
    });
    await b.channel.start(
      { config: { sessionDir: join(tmp, 's') }, secrets: {} },
      async (e) => {
        channelEmits.push(e);
      },
    );
    fake.emitConn({ connection: 'open' });
    fake.emitMessage({
      key: { remoteJid: '628@s.whatsapp.net', fromMe: false, id: 'm1' },
      message: { conversation: 'hello' },
      messageTimestamp: 1700000000,
    });
    // Allow any awaited handlers to settle.
    await new Promise((resolve) => setImmediate(resolve));
    expect(channelEmits).toHaveLength(1);
    expect(onEvent).toHaveLength(1);
    expect(channelEmits[0]!.body).toBe('hello');
    expect(channelEmits[0]!.from).toBe('628');
    expect(fake.readMock).toHaveBeenCalled(); // markRead default true
    await b.channel.stop();
  });

  it('send() routes through the typing-indicator hooks', async () => {
    const fake = makeAdapter();
    const b = createWhatsAppPersonalPlugin({ adapter: fake.adapter });
    await b.channel.start({ config: { sessionDir: join(tmp, 's') }, secrets: {} }, async () => {});
    fake.emitConn({ connection: 'open' });
    await b.channel.send!({
      channelId: 'whatsapp-personal',
      to: '628111',
      body: 'hi there',
      format: 'plain',
    });
    expect(fake.sendMock).toHaveBeenCalledWith('628111@s.whatsapp.net', { text: 'hi there' });
    expect(fake.presenceMock).toHaveBeenCalled(); // typing indicator
    await b.channel.stop();
  });

  it('send() throws before start', async () => {
    const fake = makeAdapter();
    const b = createWhatsAppPersonalPlugin({ adapter: fake.adapter });
    await expect(
      b.channel.send!({ channelId: 'whatsapp-personal', to: '628', body: 'hi', format: 'plain' }),
    ).rejects.toThrow(/not started/);
  });

  it('send() rejects channelId mismatch', async () => {
    const fake = makeAdapter();
    const b = createWhatsAppPersonalPlugin({ adapter: fake.adapter });
    await b.channel.start({ config: { sessionDir: join(tmp, 's') }, secrets: {} }, async () => {});
    fake.emitConn({ connection: 'open' });
    await expect(
      b.channel.send!({ channelId: 'telegram', to: '628', body: 'hi', format: 'plain' }),
    ).rejects.toThrow(/channelId mismatch/);
    await b.channel.stop();
  });

  it('handleWebhook returns 405 (Personal mode has no webhook)', async () => {
    const fake = makeAdapter();
    const b = createWhatsAppPersonalPlugin({ adapter: fake.adapter });
    const r = await b.handleWebhook({
      method: 'POST',
      path: '/webhook',
      headers: {},
      body: Buffer.alloc(0),
    });
    expect(r.status).toBe(405);
    expect(r.inbound).toEqual([]);
  });

  it('emits onConnectionEvent for lifecycle transitions', async () => {
    const fake = makeAdapter();
    const seen: string[] = [];
    const b = createWhatsAppPersonalPlugin({
      adapter: fake.adapter,
      onConnectionEvent: (e) => seen.push(e.kind),
    });
    await b.channel.start({ config: { sessionDir: join(tmp, 's') }, secrets: {} }, async () => {});
    fake.emitConn({ qr: 'QR' });
    fake.emitConn({ connection: 'open' });
    fake.emitConn({
      connection: 'close',
      lastDisconnect: { error: { output: { statusCode: 401 } } },
    });
    expect(seen).toContain('connecting');
    expect(seen).toContain('qr');
    expect(seen).toContain('connected');
    expect(seen).toContain('session-expired');
    await b.channel.stop();
  });

  it('createWhatsAppPersonalMonitorSource returns just the source half', () => {
    const fake = makeAdapter();
    const src = createWhatsAppPersonalMonitorSource({ adapter: fake.adapter });
    expect(src.id).toBe('whatsapp-personal');
    expect(src.kind).toBe('push');
  });

  it('Phase 11 — channelId option overrides the default slot id', () => {
    const fake = makeAdapter();
    const b = createWhatsAppPersonalPlugin({
      adapter: fake.adapter,
      channelId: 'whatsapp-personal:work',
    });
    expect(b.channel.id).toBe('whatsapp-personal:work');
    expect(b.source.id).toBe('whatsapp-personal:work');
  });

  it('Phase 11 — invalid channelId throws fail-fast', () => {
    const fake = makeAdapter();
    expect(() =>
      createWhatsAppPersonalPlugin({
        adapter: fake.adapter,
        channelId: 'WhatsApp Personal!', // uppercase + space + bang — all invalid
      }),
    ).toThrow(/invalid channelId/);
  });

  it('Phase 11 — DEFAULT_WHATSAPP_PERSONAL_ID is the canonical base id', () => {
    expect(DEFAULT_WHATSAPP_PERSONAL_ID).toBe('whatsapp-personal');
  });

  it('Phase 11 — monitor-only bundle marks channel as monitor-source kind', () => {
    const fake = makeAdapter();
    const b = createWhatsAppPersonalMonitorOnlyBundle({
      adapter: fake.adapter,
      channelId: 'whatsapp-personal:family',
    });
    expect(b.channel.id).toBe('whatsapp-personal:family');
    expect(b.channel.kind).toBe('monitor-source');
    expect(b.channel.features.dm).toBe(false);
    expect(b.channel.features.group).toBe(false);
  });

  it('Phase 11 — monitor-only bundle send() throws MonitorOnlySlotError', async () => {
    const fake = makeAdapter();
    const b = createWhatsAppPersonalMonitorOnlyBundle({
      adapter: fake.adapter,
      channelId: 'whatsapp-personal:work',
    });
    await b.channel.start({ config: { sessionDir: join(tmp, 's') }, secrets: {} }, async () => {});
    fake.emitConn({ connection: 'open' });
    await expect(
      b.channel.send!({
        channelId: 'whatsapp-personal:work',
        to: '628',
        body: 'hi',
        format: 'plain',
      }),
    ).rejects.toThrow(MonitorOnlySlotError);
    await b.channel.stop();
  });

  it('source.webhook returns empty array (no HTTP path)', async () => {
    const fake = makeAdapter();
    const b = createWhatsAppPersonalPlugin({ adapter: fake.adapter });
    const events = await b.source.webhook!({
      method: 'POST',
      path: '/webhook',
      headers: {},
      body: Buffer.alloc(0),
    });
    expect(events).toEqual([]);
  });
});
