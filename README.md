# SwarmAI Channel: WhatsApp Personal (Baileys)

SwarmAI channel plugin that connects to a personal WhatsApp account via [Baileys](https://github.com/WhiskeySockets/Baileys) — a direct WebSocket implementation of the WhatsApp Multi-Device protocol. No browser required.

## When to use this

- **You want fast text messaging.** Cold-start in 1-3 seconds, sub-second send latency, ~50MB RAM.
- **You can't run a persistent browser process.** Headless environments, container deployments, Windows services, low-resource hosts.
- **Most messages are text or small inbound media.**

## When to use [WhatsApp Web.js plugin](https://github.com/northpeakmalaysia/swarmai-channel-whatsapp-webjs) instead

- **You send a lot of documents / images / videos.** Baileys' separate `mmg.whatsapp.net` upload path can hang in daemon-mode contexts (see [docs/38](https://github.com/northpeakmalaysia/swarmai/blob/main/docs/38-whatsapp-dual-plugin-plan.md)). Web.js delegates upload to the browser's own JS for better reliability.
- **You have ~300MB RAM to spare** for a persistent Chrome process.

Both plugins can be installed simultaneously and paired to the **same WhatsApp account** (Multi-Device supports up to 4 linked devices). The Main Agent picks the right one per send: text → Baileys, media → Web.js.

## Installation

Via the SwarmAI Hub:

```bash
swarmai hub install channel-whatsapp-baileys
```

Or from the dashboard: **Hub → Channels → WhatsApp (Baileys) → Install**.

## Pairing

After install, pair via QR code:

1. Open **Channels** pane in the dashboard
2. Click **Pair** on the WhatsApp (Baileys) row
3. Scan the QR code from your phone's WhatsApp:
   - Phone: **Settings → Linked Devices → Link a Device**
   - Scan the QR code displayed in the dashboard
4. Wait for "Connected" status (usually 5-10 seconds)

Session credentials are stored at `<workspace>/.swarmai/baileys/`. They persist across restarts — no re-pairing needed.

## Channel kind

This plugin registers channel kind **`whatsapp-personal`** (NOT `whatsapp-baileys`). This is for backwards compatibility — existing operator workspaces reference `whatsapp-personal` in their `sources.yaml`, approval ledgers, and trigger configs. Renaming would break every existing config.

The Web.js variant registers as **`whatsapp-webjs`** to coexist without conflict.

## Features

| Capability | Supported |
|---|---|
| Direct messages (1-to-1) | ✓ |
| Group messages | ✓ |
| Send images | ✓ |
| Send videos | ✓ (small — large files may time out, see "Known issues") |
| Send audio + voice memos | ✓ |
| Send documents (PDF, etc.) | ✓ (small — large files may time out) |
| Typing indicator | ✓ |
| Read receipts | ✓ |
| Reactions | ✓ |
| Voice/video calls | ✗ (not supported by Baileys) |
| Channels (broadcast) | ✗ (read-only — Baileys' channels API is limited) |
| Status posts | ✗ |

## Known issues

- **Media uploads can hang in Windows service / NSSM Session 0 contexts.** Baileys uploads media via a separate HTTPS connection to `mmg.whatsapp.net` which behaves differently in service contexts. Mitigation: this plugin includes a 45-second per-send timeout with heartbeat diagnostics so failures fail-fast with actionable errors. For reliable media, use the Web.js plugin instead.
- **Privacy IDs (`@lid`) can't be derived from phone numbers.** When the agent is asked to message a NEW phone number she's never received from, the plugin can't predict whether they're on a `@s.whatsapp.net` or `@lid` account — the send may go to a non-existent JID and time out. See [docs/38](https://github.com/northpeakmalaysia/swarmai/blob/main/docs/38-whatsapp-dual-plugin-plan.md).

## Development

```bash
npm install
npm run build
npm test
```

Tests use a fake Baileys adapter (`src/baileys-client.test.ts`) so the full WebSocket / Signal protocol stack doesn't need to be exercised in CI.

## License

PolyForm Noncommercial 1.0.0 — see [LICENSE](./LICENSE).

For commercial use, contact [support@northpeak.app](mailto:support@northpeak.app).
