import { describe, it, expect } from 'vitest';
import { normaliseForWhatsApp } from './format.js';

describe('whatsapp-personal/normaliseForWhatsApp', () => {
  it('collapses [label](url) into "label: url"', () => {
    expect(normaliseForWhatsApp('See [docs](https://example.com).')).toBe(
      'See docs: https://example.com.',
    );
  });

  it('drops bracket+paren when label equals url', () => {
    expect(
      normaliseForWhatsApp('Visit [https://example.com](https://example.com)'),
    ).toBe('Visit https://example.com');
  });

  it('strips heading prefixes', () => {
    expect(normaliseForWhatsApp('## Sub\nbody')).toBe('Sub\nbody');
  });

  it('preserves *bold* / _italic_ / ~strike~', () => {
    const input = '*b* _i_ ~s~';
    expect(normaliseForWhatsApp(input)).toBe(input);
  });

  it('returns empty unchanged', () => {
    expect(normaliseForWhatsApp('')).toBe('');
  });
});
