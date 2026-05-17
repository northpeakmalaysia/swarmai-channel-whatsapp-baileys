import { describe, it, expect } from 'vitest';
import { renderQr } from './qr-display.js';

describe('qr-display/renderQr', () => {
  it('invokes onRender callback when provided', async () => {
    const seen: Array<{ qr: string; ascii?: string }> = [];
    await renderQr('TEST-QR-PAYLOAD', {
      onRender: (qr, ascii) => {
        seen.push({ qr, ...(ascii !== undefined ? { ascii } : {}) });
      },
    });
    expect(seen.length).toBe(1);
    expect(seen[0]!.qr).toBe('TEST-QR-PAYLOAD');
    // Either qrcode-terminal rendered ASCII, or the fallback printed
    // a string mentioning "QR pairing".
    expect(typeof seen[0]!.ascii).toBe('string');
  });

  it('writes to a custom stream when no onRender', async () => {
    const chunks: Buffer[] = [];
    const stream = {
      write(s: string | Uint8Array): boolean {
        chunks.push(Buffer.from(typeof s === 'string' ? s : s));
        return true;
      },
    } as NodeJS.WritableStream;
    await renderQr('STREAM-QR', { stream });
    const combined = Buffer.concat(chunks).toString('utf8');
    // Fallback or rendered ASCII — either way the QR must be visible.
    expect(combined.length).toBeGreaterThan(0);
  });
});
