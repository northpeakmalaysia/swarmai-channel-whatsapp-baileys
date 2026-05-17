/**
 * QR display helper — renders a Baileys-supplied QR string as ASCII
 * art on stderr so users can pipe stdout to log files without QR
 * pollution.
 *
 * `qrcode-terminal` is a lazy peer dep — we dynamically import on
 * first use. If it isn't installed (server bundle doesn't ship it
 * by default) we fall back to printing the raw QR string with a
 * note explaining how to regenerate it via an external tool.
 */

export interface QrDisplayOptions {
  /** Use the `small` flag — denser ASCII, fits more terminals. Default true. */
  small?: boolean;
  /** Print to this stream (default `process.stderr`). */
  stream?: NodeJS.WritableStream;
  /**
   * Hook for tests — if provided, called with the rendered QR string
   * instead of writing to the stream. The real implementation in
   * production never sets this.
   */
  onRender?: (qr: string, ascii?: string) => void;
}

/**
 * Render a QR string to the terminal. Returns a promise that resolves
 * once the rendering completes (the underlying lib is sync but uses a
 * callback API).
 */
export async function renderQr(qr: string, opts: QrDisplayOptions = {}): Promise<void> {
  const stream = opts.stream ?? process.stderr;
  const small = opts.small ?? true;

  // Lazy load — qrcode-terminal is a peer dep that's only needed in
  // setup flows. Server bundles that never use Personal mode don't
  // need to ship it.
  let qrcodeTerminal: typeof import('qrcode-terminal') | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    qrcodeTerminal = (await import('qrcode-terminal')) as any;
  } catch {
    qrcodeTerminal = null;
  }

  if (!qrcodeTerminal) {
    const fallback =
      `[QR pairing — install qrcode-terminal to render ASCII art]\n` +
      `Raw QR: ${qr}\n` +
      `Or scan via https://qr-code-generator.com with this string.\n`;
    if (opts.onRender) opts.onRender(qr, fallback);
    else stream.write(fallback);
    return;
  }

  // qrcode-terminal exposes `generate(text, opts, cb)` where cb gets
  // the rendered ASCII. Wrap into a Promise.
  await new Promise<void>((resolve) => {
    qrcodeTerminal!.generate(qr, { small }, (ascii: string) => {
      if (opts.onRender) opts.onRender(qr, ascii);
      else stream.write(ascii + '\n');
      resolve();
    });
  });
}
