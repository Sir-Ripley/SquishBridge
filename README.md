# Squish Bridge

A Chrome extension that pairs your own signed-in Chrome to your Muse agent, letting it drive one tab you designate. Your session, your network, your passkeys — credentials are never read or shared.

> **Status: M2 eyes landed.** The full design is written and approved ([`docs/DESIGN.md`](docs/DESIGN.md)); pairing and the Squish → bridge → extension command round trip work end to end, with `navigate`, `screenshot`, `dom_snapshot`, and `get_state` driving the shared tab over CDP. The wire protocol is specified in [`docs/PROTOCOL.md`](docs/PROTOCOL.md). Next: M3 hands (click/type/keys). Note: real-tab attach is code-verified with a stubbed `chrome` API — first live attach happens on Rodney's machine when he reloads the extension.

## Why

A personal AI agent works from its own computer, with its own browser. That browser has none of your sign-ins, connects from an unfamiliar network, and can't use the passkeys on your devices. Those three mismatches — **session, network, hardware keys** — break real tasks: passkey-only sites can't be signed into, security systems flag the unfamiliar network, and anything that must happen inside your account in a browser becomes a manual workaround.

Squish Bridge closes the gap from the other direction: instead of the agent's browser trying to become you, the agent is invited into **your** browser, on **one tab you choose**, under rules you control.

## How it works

Three pieces (details in the design doc):

- **Extension** (Manifest V3) — lives in your Chrome. You pair it once with a one-time code, designate the shared tab, and start/stop control sessions. While a session runs, it drives that tab through the Chrome DevTools Protocol and returns screenshots and page structure to the agent.
- **Bridge server** — runs on the agent's computer. The extension connects to it outbound over a private channel (Tailscale), so nothing is exposed on your network. It routes commands and results, and keeps an audit log.
- **The agent** — works the shared tab through the bridge with the same observe → act → verify loop it uses in its own browser.

## Safety model

This is the heart of the project, not a feature list:

- **No credentials, ever.** The extension requests no `cookies` permission and never reads passwords, cookies, or passkeys. If a page asks you to sign in, the agent stops and *you* sign in — then work continues.
- **Your tab, your call.** Control applies only to a tab you explicitly share, one at a time.
- **Visible and stoppable.** A persistent on-page banner while control is active, plus a hard STOP (button and keyboard shortcut) that ends the session instantly.
- **Allowlist enforced in the extension.** Only origins you approve can be driven; a built-in denylist (banking, password managers) always wins.
- **Everything is logged.** Every command and its outcome lands in an audit log you can open at any time.

## Repository layout

```
extension/   the Chrome extension (MV3)
bridge/      the bridge server
docs/        design and project documents
```

## Development

Chrome extensions aren't compiled like apps — they're a folder of files. Once the scaffold lands:

1. Open `chrome://extensions` in Chrome
2. Enable **Developer mode**
3. **Load unpacked** → select the `extension/` folder
4. After code changes, click the extension card's reload button

No Chrome Web Store account is needed for personal use.

Bridge server (Node 20+):

```
cd bridge
npm test    # unit tests: health endpoint, token helpers
npm start   # serves http://127.0.0.1:3031 (loopback-only)
```

Extension logic tests (no Chrome needed):

```
node --test extension/test/*.test.js
```

## Design & roadmap

- Design document: [`docs/DESIGN.md`](docs/DESIGN.md) — architecture, pairing & auth, permissions with justifications, the full safety model, v0 scope, and acceptance missions
- Build order: M0 scaffold → M1 pairing → M2 eyes (navigate/screenshot/DOM) → M3 hands (click/type/keys) → M4 safety hardening → M5 acceptance missions
- v0 acceptance missions: create a GitHub repo in a signed-in browser, open a NotebookLM notebook in the owner's session, and a mid-session stop drill

## License

Mozilla Public License 2.0 — see [`LICENSE`](LICENSE).
