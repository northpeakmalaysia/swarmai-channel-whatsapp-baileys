import { describe, it, expect } from 'vitest';
import {
  normaliseBaileysMessage,
  phoneFromJid,
  readSenderId,
  detectMention,
  isGroupRemoteJid,
  isLidJid,
} from './inbound-normaliser.js';
import type { BaileysWAMessage } from './types.js';

const baseKey = (overrides: Partial<BaileysWAMessage['key']> = {}): BaileysWAMessage['key'] => ({
  remoteJid: '628123456789@s.whatsapp.net',
  fromMe: false,
  id: 'msg-1',
  ...overrides,
});

describe('inbound-normaliser/phoneFromJid', () => {
  it('strips the @s.whatsapp.net suffix', () => {
    expect(phoneFromJid('628123@s.whatsapp.net')).toBe('628123');
  });

  it('strips the device suffix `:1`', () => {
    expect(phoneFromJid('628123:5@s.whatsapp.net')).toBe('628123');
  });

  it('handles group jids by returning the bare id', () => {
    expect(phoneFromJid('120363@g.us')).toBe('120363');
  });
});

describe('inbound-normaliser/readSenderId', () => {
  it('returns participant for group messages', () => {
    const msg: BaileysWAMessage = {
      key: baseKey({ remoteJid: '120363@g.us', participant: '628999@s.whatsapp.net' }),
      message: { conversation: 'hi' },
    };
    expect(readSenderId(msg)).toBe('628999');
  });

  it('returns remoteJid for DMs', () => {
    const msg: BaileysWAMessage = {
      key: baseKey({ remoteJid: '628123@s.whatsapp.net' }),
      message: { conversation: 'hi' },
    };
    expect(readSenderId(msg)).toBe('628123');
  });
});

describe('inbound-normaliser/normaliseBaileysMessage', () => {
  it('skips fromMe outbound echoes', () => {
    const msg: BaileysWAMessage = {
      key: baseKey({ fromMe: true }),
      message: { conversation: 'hi' },
    };
    expect(normaliseBaileysMessage('whatsapp', msg)).toBeNull();
  });

  it('skips messages with no content', () => {
    const msg: BaileysWAMessage = { key: baseKey() };
    expect(normaliseBaileysMessage('whatsapp', msg)).toBeNull();
  });

  it('decodes a plain text "conversation"', () => {
    const msg: BaileysWAMessage = {
      key: baseKey(),
      message: { conversation: 'hello athena' },
      messageTimestamp: 1700000000,
    };
    const e = normaliseBaileysMessage('whatsapp', msg)!;
    expect(e.body).toBe('hello athena');
    expect(e.from).toBe('628123456789');
    expect(e.attachments).toBeUndefined();
    expect(e.channelId).toBe('whatsapp');
    expect(e.receivedAt).toBeInstanceOf(Date);
  });

  it('decodes an extendedTextMessage', () => {
    const msg: BaileysWAMessage = {
      key: baseKey(),
      message: { extendedTextMessage: { text: 'rich text' } },
    };
    const e = normaliseBaileysMessage('whatsapp', msg)!;
    expect(e.body).toBe('rich text');
  });

  it('decodes an image with caption', () => {
    const msg: BaileysWAMessage = {
      key: baseKey(),
      message: { imageMessage: { mimetype: 'image/jpeg', caption: 'look at this' } },
    };
    const e = normaliseBaileysMessage('whatsapp', msg)!;
    expect(e.body).toBe('look at this');
    expect(e.attachments?.[0]).toMatchObject({ kind: 'image', mimeType: 'image/jpeg' });
  });

  it('decodes a voice message (ptt) as audio attachment', () => {
    const msg: BaileysWAMessage = {
      key: baseKey(),
      message: { audioMessage: { mimetype: 'audio/ogg', ptt: true } },
    };
    const e = normaliseBaileysMessage('whatsapp', msg)!;
    expect(e.attachments?.[0]?.kind).toBe('audio');
    expect(e.body).toBe('');
  });

  it('decodes a document with filename', () => {
    const msg: BaileysWAMessage = {
      key: baseKey(),
      message: {
        documentMessage: {
          mimetype: 'application/pdf',
          fileName: 'report.pdf',
          caption: 'see attached',
        },
      },
    };
    const e = normaliseBaileysMessage('whatsapp', msg)!;
    expect(e.attachments?.[0]).toMatchObject({
      kind: 'file',
      mimeType: 'application/pdf',
      filename: 'report.pdf',
    });
    expect(e.body).toBe('see attached');
  });

  it('falls through unknown types with a placeholder body', () => {
    // Cast through `unknown` so we can construct a content shape
    // Baileys would emit but we don't have a typed slot for.
    const msg = {
      key: baseKey(),
      message: { someUnknownThing: { foo: 'bar' } } as unknown,
    } as BaileysWAMessage;
    const e = normaliseBaileysMessage('whatsapp', msg)!;
    expect(e.body).toBe('[whatsapp-personal:unknown]');
  });
});

describe('inbound-normaliser/isGroupRemoteJid', () => {
  it('detects group jids', () => {
    expect(isGroupRemoteJid('120363@g.us')).toBe(true);
  });
  it('rejects DM jids', () => {
    expect(isGroupRemoteJid('628123@s.whatsapp.net')).toBe(false);
  });
  it('handles undefined gracefully', () => {
    expect(isGroupRemoteJid(undefined)).toBe(false);
  });
});

describe('inbound-normaliser/detectMention', () => {
  const baseMsg = (overrides: Partial<BaileysWAMessage> = {}): BaileysWAMessage => ({
    key: { remoteJid: '120363@g.us', participant: '628999@s.whatsapp.net', fromMe: false },
    message: { conversation: 'just a casual message' },
    ...overrides,
  });

  it('returns false when neither selfJid nor selfDisplayName provided', () => {
    expect(detectMention(baseMsg(), 'hi @628111', {})).toBe(false);
  });

  it('detects a structured mentionedJid match', () => {
    const msg = baseMsg({
      message: {
        extendedTextMessage: {
          text: 'hey there',
          contextInfo: { mentionedJid: ['628111@s.whatsapp.net'] },
        },
      },
    });
    expect(
      detectMention(msg, 'hey there', { selfJid: '628111@s.whatsapp.net' }),
    ).toBe(true);
  });

  it('detects digits-based mention in body when no structured list exists', () => {
    expect(
      detectMention(baseMsg(), 'morning @628111 can you help', {
        selfJid: '628111@s.whatsapp.net',
      }),
    ).toBe(true);
  });

  it('detects display-name mention case-insensitively', () => {
    expect(
      detectMention(baseMsg(), 'morning @ATHENA can you help', {
        selfDisplayName: 'Athena',
      }),
    ).toBe(true);
    expect(
      detectMention(baseMsg(), 'morning @athena can you help', {
        selfDisplayName: 'Athena',
      }),
    ).toBe(true);
  });

  it('returns false when no mention is present', () => {
    expect(
      detectMention(baseMsg(), 'just chatting in the group', {
        selfJid: '628111@s.whatsapp.net',
        selfDisplayName: 'Athena',
      }),
    ).toBe(false);
  });

  it('strips device suffix when comparing JIDs', () => {
    const msg = baseMsg({
      message: {
        extendedTextMessage: {
          text: 'hi',
          contextInfo: { mentionedJid: ['628111:5@s.whatsapp.net'] },
        },
      },
    });
    expect(
      detectMention(msg, 'hi', { selfJid: '628111@s.whatsapp.net' }),
    ).toBe(true);
  });
});

describe('inbound-normaliser/normaliseBaileysMessage — flags', () => {
  const baseKeyDm = (): BaileysWAMessage['key'] => ({
    remoteJid: '628123@s.whatsapp.net',
    fromMe: false,
    id: 'msg-dm',
  });
  const baseKeyGroup = (): BaileysWAMessage['key'] => ({
    remoteJid: '120363@g.us',
    fromMe: false,
    id: 'msg-grp',
    participant: '628999@s.whatsapp.net',
  });

  // A12 (2026-05-08) — every inbound now surfaces `chatType` so the
  // bridge's group-policy gate can dispatch without re-parsing the
  // raw payload. DMs get `chatType: 'private'` (no longer undefined);
  // groups get `chatType: 'group'` + `groupChat: true` + `groupId`.
  it('sets chatType=private for DMs (A12)', () => {
    const msg: BaileysWAMessage = {
      key: baseKeyDm(),
      message: { conversation: 'hi' },
    };
    const e = normaliseBaileysMessage('whatsapp', msg)!;
    expect(e.flags).toEqual({ chatType: 'private' });
  });

  it('sets groupChat + chatType=group + groupId for group messages (A12)', () => {
    const msg: BaileysWAMessage = {
      key: baseKeyGroup(),
      message: { conversation: 'morning all' },
    };
    const e = normaliseBaileysMessage('whatsapp', msg)!;
    expect(e.flags).toEqual({
      chatType: 'group',
      groupChat: true,
      groupId: '120363@g.us',
    });
  });

  it('sets mentioned flag when bot is @-mentioned in a group', () => {
    const msg: BaileysWAMessage = {
      key: baseKeyGroup(),
      message: {
        extendedTextMessage: {
          text: 'hi @628111 can you help',
          contextInfo: { mentionedJid: ['628111@s.whatsapp.net'] },
        },
      },
    };
    const e = normaliseBaileysMessage('whatsapp', msg, {
      selfJid: '628111@s.whatsapp.net',
    })!;
    expect(e.flags?.['mentioned']).toBe(true);
    expect(e.flags?.['groupChat']).toBe(true);
    expect(e.flags?.['chatType']).toBe('group');
  });

  it('sets mentioned flag from display-name mention even without a JID match', () => {
    const msg: BaileysWAMessage = {
      key: baseKeyGroup(),
      message: { conversation: '@Athena what time is the meeting?' },
    };
    const e = normaliseBaileysMessage('whatsapp', msg, {
      selfJid: '999@s.whatsapp.net', // doesn't match anything
      selfDisplayName: 'Athena',
    })!;
    expect(e.flags?.['mentioned']).toBe(true);
    expect(e.flags?.['groupChat']).toBe(true);
  });

  it('group message without @-mention: groupChat true, mentioned absent', () => {
    const msg: BaileysWAMessage = {
      key: baseKeyGroup(),
      message: { conversation: 'just a casual chat' },
    };
    const e = normaliseBaileysMessage('whatsapp', msg, {
      selfJid: '628111@s.whatsapp.net',
      selfDisplayName: 'Athena',
    })!;
    expect(e.flags?.['groupChat']).toBe(true);
    expect(e.flags?.['mentioned']).toBeUndefined();
  });
});

// 2026-05-17 — identity surfacing via SenderProfile. WhatsApp messages
// carry pushName + JID; only @s.whatsapp.net JIDs encode a phone number,
// @lid JIDs are WhatsApp's opaque Privacy IDs (no phone derivable here).
describe('inbound-normaliser/isLidJid', () => {
  it('detects @lid Privacy IDs', () => {
    expect(isLidJid('11223344@lid')).toBe(true);
  });
  it('rejects regular phone JIDs', () => {
    expect(isLidJid('628123@s.whatsapp.net')).toBe(false);
  });
  it('rejects group JIDs', () => {
    expect(isLidJid('120363@g.us')).toBe(false);
  });
});

describe('inbound-normaliser/normaliseBaileysMessage — senderProfile', () => {
  it('surfaces pushName + phoneNumber + rawId for @s.whatsapp.net DMs', () => {
    const msg: BaileysWAMessage = {
      key: baseKey({ remoteJid: '628123456789@s.whatsapp.net' }),
      message: { conversation: 'hi' },
      pushName: 'Ahmad Razak',
    };
    const e = normaliseBaileysMessage('whatsapp', msg)!;
    expect(e.senderProfile).toEqual({
      displayName: 'Ahmad Razak',
      phoneNumber: '628123456789',
      rawId: '628123456789@s.whatsapp.net',
    });
  });

  it('@lid sender: pushName + rawId only, phoneNumber undefined', () => {
    const msg: BaileysWAMessage = {
      key: baseKey({ remoteJid: '99887766@lid' }),
      message: { conversation: 'hi' },
      pushName: 'Privacy Sam',
    };
    const e = normaliseBaileysMessage('whatsapp', msg)!;
    expect(e.senderProfile?.displayName).toBe('Privacy Sam');
    expect(e.senderProfile?.rawId).toBe('99887766@lid');
    expect(e.senderProfile?.phoneNumber).toBeUndefined();
  });

  it('group message uses participant JID for senderProfile, not remoteJid', () => {
    const msg: BaileysWAMessage = {
      key: baseKey({
        remoteJid: '120363@g.us',
        participant: '628999111@s.whatsapp.net',
      }),
      message: { conversation: 'in a group' },
      pushName: 'Group Member',
    };
    const e = normaliseBaileysMessage('whatsapp', msg)!;
    expect(e.senderProfile?.phoneNumber).toBe('628999111');
    expect(e.senderProfile?.rawId).toBe('628999111@s.whatsapp.net');
  });

  it('omits displayName when pushName is absent (still surfaces phone + rawId)', () => {
    const msg: BaileysWAMessage = {
      key: baseKey({ remoteJid: '628123@s.whatsapp.net' }),
      message: { conversation: 'no name' },
    };
    const e = normaliseBaileysMessage('whatsapp', msg)!;
    expect(e.senderProfile?.displayName).toBeUndefined();
    expect(e.senderProfile?.phoneNumber).toBe('628123');
    expect(e.senderProfile?.rawId).toBe('628123@s.whatsapp.net');
  });

  it('never sets username (WhatsApp has no username concept)', () => {
    const msg: BaileysWAMessage = {
      key: baseKey({ remoteJid: '628123@s.whatsapp.net' }),
      message: { conversation: 'hi' },
      pushName: 'Anyone',
    };
    const e = normaliseBaileysMessage('whatsapp', msg)!;
    expect(e.senderProfile?.username).toBeUndefined();
  });
});
