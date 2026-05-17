import { describe, it, expect } from 'vitest';
import {
  WhatsAppPersonalConfigSchema,
  WhatsAppPersonalAuthSchema,
} from './types.js';

describe('WhatsAppPersonalConfigSchema', () => {
  it('applies default values for missing fields', () => {
    const r = WhatsAppPersonalConfigSchema.parse({});
    expect(r.sessionId).toBe('default');
    expect(r.logLevel).toBe('silent');
    expect(r.markRead).toBe(true);
    expect(r.typingIndicator).toBe(true);
    expect(r.reconnectBaseBackoffMs).toBe(1000);
    expect(r.reconnectMaxBackoffMs).toBe(30_000);
    expect(r.reconnectMaxAttempts).toBe(5);
  });

  it('rejects negative reconnect values', () => {
    expect(() =>
      WhatsAppPersonalConfigSchema.parse({ reconnectBaseBackoffMs: -1 }),
    ).toThrow();
  });

  it('preserves explicit overrides', () => {
    const r = WhatsAppPersonalConfigSchema.parse({
      sessionId: '+628999',
      logLevel: 'warn',
      markRead: false,
      typingIndicator: false,
      reconnectMaxAttempts: 10,
    });
    expect(r.sessionId).toBe('+628999');
    expect(r.logLevel).toBe('warn');
    expect(r.markRead).toBe(false);
    expect(r.typingIndicator).toBe(false);
    expect(r.reconnectMaxAttempts).toBe(10);
  });
});

describe('WhatsAppPersonalAuthSchema', () => {
  it('accepts an empty object (no secrets needed for Personal)', () => {
    expect(WhatsAppPersonalAuthSchema.parse({})).toEqual({});
  });

  it('passes extra fields through (forward-compat)', () => {
    const r = WhatsAppPersonalAuthSchema.parse({ extra: 'value' });
    expect((r as { extra?: string }).extra).toBe('value');
  });
});
