import { describe, it, expect, vi } from 'vitest';
import {
  sendOutboundText,
  toJid,
  isGroupJid,
  validateAttachment,
  isVoiceMemo,
  resolveMediaBuffer,
  buildMediaContent,
  MEDIA_SIZE_CAPS,
} from './outbound-sender.js';
import type { BaileysClient } from './baileys-client.js';
import type { Attachment } from '@swarmai/plugin-sdk';

describe('outbound-sender/toJid', () => {
  it('appends the s.whatsapp.net suffix to bare numbers', () => {
    expect(toJid('628123456789')).toBe('628123456789@s.whatsapp.net');
    expect(toJid('+628123456789')).toBe('628123456789@s.whatsapp.net');
  });

  it('passes through existing JIDs', () => {
    expect(toJid('628@s.whatsapp.net')).toBe('628@s.whatsapp.net');
    expect(toJid('120363@g.us')).toBe('120363@g.us');
  });

  it('returns null for empty / non-numeric input', () => {
    expect(toJid('')).toBe(null);
    expect(toJid('   ')).toBe(null);
    expect(toJid('letters-only')).toBe(null);
  });
});

describe('outbound-sender/isGroupJid', () => {
  it('detects @g.us as group', () => {
    expect(isGroupJid('120363@g.us')).toBe(true);
  });
  it('rejects DMs', () => {
    expect(isGroupJid('628123@s.whatsapp.net')).toBe(false);
  });
});

describe('outbound-sender/sendOutboundText', () => {
  function fakeClient(): BaileysClient {
    return {
      sendText: vi.fn(async (_jid: string, _body: string) => 'wam-id-1'),
      sendMessage: vi.fn(async (_jid: string, _content: unknown) => 'wam-id-media-1'),
      setTyping: vi.fn(async () => {}),
    } as unknown as BaileysClient;
  }

  it('rejects channelId mismatches', async () => {
    const client = fakeClient();
    const r = await sendOutboundText(
      { client, channelId: 'whatsapp' },
      { channelId: 'telegram', to: '628', body: 'hi', format: 'plain' },
    );
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/mismatch/);
  });

  it('rejects empty bodies (without attachments)', async () => {
    const client = fakeClient();
    const r = await sendOutboundText(
      { client, channelId: 'whatsapp' },
      { channelId: 'whatsapp', to: '628', body: '', format: 'plain' },
    );
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/empty body/);
  });

  it('rejects unresolvable recipients', async () => {
    const client = fakeClient();
    const r = await sendOutboundText(
      { client, channelId: 'whatsapp' },
      { channelId: 'whatsapp', to: '!!!', body: 'hi', format: 'plain' },
    );
    expect(r.ok).toBe(false);
  });

  it('forwards a valid message and returns the message id', async () => {
    const client = fakeClient();
    const r = await sendOutboundText(
      { client, channelId: 'whatsapp' },
      { channelId: 'whatsapp', to: '628111', body: 'hello', format: 'plain' },
    );
    expect(r.ok).toBe(true);
    expect(r.messageId).toBe('wam-id-1');
    expect((client.sendText as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      '628111@s.whatsapp.net',
      'hello',
    );
  });

  it('normalises markdown links / headings before handing to Baileys (issue #10)', async () => {
    const client = fakeClient();
    await sendOutboundText(
      { client, channelId: 'whatsapp' },
      {
        channelId: 'whatsapp',
        to: '628',
        body: '# Title\nSee [docs](https://example.com).',
        format: 'markdown',
      },
    );
    expect((client.sendText as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      '628@s.whatsapp.net',
      'Title\nSee docs: https://example.com.',
    );
  });

  it('runs onBeforeSend / onAfterSend hooks (typing indicator)', async () => {
    const client = fakeClient();
    const before = vi.fn(async () => {});
    const after = vi.fn(async () => {});
    await sendOutboundText(
      { client, channelId: 'whatsapp', onBeforeSend: before, onAfterSend: after },
      { channelId: 'whatsapp', to: '628', body: 'hi', format: 'plain' },
    );
    expect(before).toHaveBeenCalledWith('628@s.whatsapp.net');
    expect(after).toHaveBeenCalledWith('628@s.whatsapp.net');
  });

  it('returns ok=false when sendText throws', async () => {
    const client = {
      sendText: vi.fn(async () => {
        throw new Error('boom');
      }),
    } as unknown as BaileysClient;
    const r = await sendOutboundText(
      { client, channelId: 'whatsapp' },
      { channelId: 'whatsapp', to: '628', body: 'x', format: 'plain' },
    );
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/boom/);
  });

  it('survives a throwing onBeforeSend hook (typing-indicator failure is non-fatal)', async () => {
    const client = fakeClient();
    const r = await sendOutboundText(
      {
        client,
        channelId: 'whatsapp',
        onBeforeSend: async () => {
          throw new Error('typing-failed');
        },
      },
      { channelId: 'whatsapp', to: '628', body: 'hi', format: 'plain' },
    );
    expect(r.ok).toBe(true);
  });
});

describe('outbound-sender/validateAttachment', () => {
  it('accepts a well-formed image attachment', () => {
    expect(
      validateAttachment({
        kind: 'image',
        mimeType: 'image/jpeg',
        data: Buffer.from('xx'),
      }),
    ).toEqual({ ok: true });
  });

  it('rejects mismatched mimeType for image kind', () => {
    const r = validateAttachment({
      kind: 'image',
      mimeType: 'video/mp4',
      data: Buffer.from('xx'),
    });
    expect(r.ok).toBe(false);
  });

  it('rejects when neither data nor url is supplied', () => {
    const r = validateAttachment({ kind: 'image', mimeType: 'image/png' } as Attachment);
    expect(r.ok).toBe(false);
  });

  it('accepts any mime for `file` kind', () => {
    expect(
      validateAttachment({
        kind: 'file',
        mimeType: 'application/pdf',
        url: 'https://example.com/x.pdf',
      }).ok,
    ).toBe(true);
    expect(
      validateAttachment({
        kind: 'file',
        mimeType: 'text/csv',
        data: Buffer.from('x'),
      }).ok,
    ).toBe(true);
  });

  it('rejects missing mimeType', () => {
    const r = validateAttachment({ kind: 'image', data: Buffer.from('x') } as Attachment);
    expect(r.ok).toBe(false);
  });
});

describe('outbound-sender/isVoiceMemo', () => {
  it('detects ogg/opus as a voice memo', () => {
    expect(isVoiceMemo('audio/ogg; codecs=opus')).toBe(true);
    expect(isVoiceMemo('AUDIO/OGG; CODECS=OPUS')).toBe(true);
  });
  it('rejects regular audio', () => {
    expect(isVoiceMemo('audio/mpeg')).toBe(false);
    expect(isVoiceMemo('audio/wav')).toBe(false);
  });
});

describe('outbound-sender/resolveMediaBuffer', () => {
  it('returns a Buffer untouched when data is supplied', async () => {
    const buf = Buffer.from('hello');
    const r = await resolveMediaBuffer({
      kind: 'image',
      mimeType: 'image/png',
      data: buf,
    });
    expect(Buffer.isBuffer(r)).toBe(true);
    expect(r.toString()).toBe('hello');
  });

  it('fetches when url is supplied', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => new TextEncoder().encode('xx').buffer as ArrayBuffer,
    }));
    const r = await resolveMediaBuffer(
      { kind: 'image', mimeType: 'image/png', url: 'https://example.com/x.png' },
      fetchImpl,
    );
    expect(fetchImpl).toHaveBeenCalledWith('https://example.com/x.png');
    expect(r.toString()).toBe('xx');
  });

  it('throws on a failed fetch', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 500,
      arrayBuffer: async () => new ArrayBuffer(0),
    }));
    await expect(
      resolveMediaBuffer(
        { kind: 'image', mimeType: 'image/png', url: 'https://example.com/x' },
        fetchImpl,
      ),
    ).rejects.toThrow(/500/);
  });
});

describe('outbound-sender/buildMediaContent', () => {
  const buf = Buffer.from('xx');

  it('builds an image payload with caption', () => {
    expect(
      buildMediaContent(
        { kind: 'image', mimeType: 'image/jpeg', data: buf },
        buf,
        'cap',
      ),
    ).toMatchObject({ image: buf, mimetype: 'image/jpeg', caption: 'cap' });
  });

  it('builds a video payload with no caption when none supplied', () => {
    expect(
      buildMediaContent(
        { kind: 'video', mimeType: 'video/mp4', data: buf },
        buf,
        undefined,
      ),
    ).toEqual({ video: buf, mimetype: 'video/mp4' });
  });

  it('flags voice memos as ptt', () => {
    expect(
      buildMediaContent(
        { kind: 'audio', mimeType: 'audio/ogg; codecs=opus', data: buf },
        buf,
        undefined,
      ),
    ).toMatchObject({ ptt: true });
  });

  it('does not set ptt for regular audio', () => {
    expect(
      buildMediaContent(
        { kind: 'audio', mimeType: 'audio/mpeg', data: buf },
        buf,
        undefined,
      ),
    ).not.toHaveProperty('ptt');
  });

  it('builds a document payload with filename + caption', () => {
    expect(
      buildMediaContent(
        {
          kind: 'file',
          mimeType: 'application/pdf',
          data: buf,
          filename: 'report.pdf',
        },
        buf,
        'see attached',
      ),
    ).toMatchObject({
      document: buf,
      mimetype: 'application/pdf',
      fileName: 'report.pdf',
      caption: 'see attached',
    });
  });
});

describe('outbound-sender/sendOutboundText (media path)', () => {
  function fakeClient(): BaileysClient {
    return {
      sendText: vi.fn(async () => 'text-id'),
      sendMessage: vi.fn(async () => 'media-id'),
      setTyping: vi.fn(async () => {}),
    } as unknown as BaileysClient;
  }

  it('sends an image with caption from event.body', async () => {
    const client = fakeClient();
    const r = await sendOutboundText(
      { client, channelId: 'whatsapp' },
      {
        channelId: 'whatsapp',
        to: '628',
        body: 'check this out',
        format: 'plain',
        attachments: [
          {
            kind: 'image',
            mimeType: 'image/jpeg',
            data: Buffer.from('img-bytes'),
          },
        ],
      },
    );
    expect(r.ok).toBe(true);
    expect(r.messageId).toBe('media-id');
    expect((client.sendMessage as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce();
    const [, content] = (client.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(content).toMatchObject({ caption: 'check this out' });
  });

  it('sends multiple attachments — first carries the caption, rest do not', async () => {
    const client = fakeClient();
    const r = await sendOutboundText(
      { client, channelId: 'whatsapp' },
      {
        channelId: 'whatsapp',
        to: '628',
        body: 'pics',
        format: 'plain',
        attachments: [
          { kind: 'image', mimeType: 'image/png', data: Buffer.from('a') },
          { kind: 'image', mimeType: 'image/png', data: Buffer.from('b') },
        ],
      },
    );
    expect(r.ok).toBe(true);
    expect((client.sendMessage as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(2);
    const calls = (client.sendMessage as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]![1]).toMatchObject({ caption: 'pics' });
    expect(calls[1]![1]).not.toHaveProperty('caption');
  });

  it('falls through to a trailing text send when no attachment supports caption', async () => {
    const client = fakeClient();
    const r = await sendOutboundText(
      { client, channelId: 'whatsapp' },
      {
        channelId: 'whatsapp',
        to: '628',
        body: 'voice context',
        format: 'plain',
        attachments: [
          {
            kind: 'audio',
            mimeType: 'audio/ogg; codecs=opus',
            data: Buffer.from('ogg'),
          },
        ],
      },
    );
    expect(r.ok).toBe(true);
    expect((client.sendMessage as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce();
    expect((client.sendText as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      '628@s.whatsapp.net',
      'voice context',
    );
  });

  it('rejects oversized attachments with a clear error', async () => {
    const client = fakeClient();
    const huge = Buffer.alloc(MEDIA_SIZE_CAPS.image + 1);
    const r = await sendOutboundText(
      { client, channelId: 'whatsapp' },
      {
        channelId: 'whatsapp',
        to: '628',
        body: '',
        format: 'plain',
        attachments: [{ kind: 'image', mimeType: 'image/png', data: huge }],
      },
    );
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/exceeds size cap/);
    expect((client.sendMessage as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it('rejects an image attachment whose mimeType is not image/*', async () => {
    const client = fakeClient();
    const r = await sendOutboundText(
      { client, channelId: 'whatsapp' },
      {
        channelId: 'whatsapp',
        to: '628',
        body: '',
        format: 'plain',
        attachments: [
          { kind: 'image', mimeType: 'video/mp4', data: Buffer.from('x') },
        ],
      },
    );
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/image\/\*/);
  });

  it('fetches a URL-sourced attachment then sends it', async () => {
    const client = fakeClient();
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => new TextEncoder().encode('vid-bytes').buffer as ArrayBuffer,
    }));
    const r = await sendOutboundText(
      { client, channelId: 'whatsapp', fetchImpl },
      {
        channelId: 'whatsapp',
        to: '628',
        body: '',
        format: 'plain',
        attachments: [
          { kind: 'video', mimeType: 'video/mp4', url: 'https://example.com/v.mp4' },
        ],
      },
    );
    expect(r.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith('https://example.com/v.mp4');
    expect((client.sendMessage as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce();
  });

  it('allows attachments with no body (sends media only)', async () => {
    const client = fakeClient();
    const r = await sendOutboundText(
      { client, channelId: 'whatsapp' },
      {
        channelId: 'whatsapp',
        to: '628',
        body: '',
        format: 'plain',
        attachments: [
          { kind: 'image', mimeType: 'image/png', data: Buffer.from('a') },
        ],
      },
    );
    expect(r.ok).toBe(true);
    expect((client.sendText as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});
