/**
 * WhatsApp Personal (Baileys) outbound formatting normaliser.
 *
 * Same markdown rules as the Cloud API variant — Baileys delivers
 * messages over the same WhatsApp Web protocol the user's phone uses,
 * so the supported set is identical:
 *
 *   *bold*  _italic_  ~strike~  ```code```
 *
 * Anything else (`[label](url)`, `# Heading`, inline `code`) is
 * collapsed to a clean readable form before the body hits Baileys'
 * `sendText` / caption fields.
 *
 * Kept as a sibling of the Cloud variant rather than a cross-package
 * import so the two adapters stay independently testable. If the rules
 * ever drift between modes (unlikely — same wire protocol) each side
 * can evolve in isolation.
 */

const MD_LINK = /\[([^\]]*)\]\(([^)\s]+)\)/g;
const MD_HEADING = /^\s*#{1,6}\s+(.*)$/gm;

export function normaliseForWhatsApp(input: string): string {
  if (!input) return input;
  let out = input;
  out = out.replace(MD_LINK, (_match, label: string, url: string) => {
    const lab = (label ?? '').trim();
    if (!lab || lab === url) return url;
    return `${lab}: ${url}`;
  });
  out = out.replace(MD_HEADING, (_match, body: string) => body.trim());
  return out;
}
