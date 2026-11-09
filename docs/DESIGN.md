# Squish Bridge — Design Document

**Version:** 0.1 (design only — no code yet)
**Date:** 2026-11-07
**Working title:** Squish Bridge (rename freely)
**Purpose:** A Chrome extension that pairs Rodney's own Chrome browser to Squish (his Muse agent), so Squish can operate a user-designated tab inside Rodney's real, signed-in session — the capability the Muse Mac app already provides on macOS, built here for Windows/ChromeOS.

---

## 1. Problem statement

Squish works from a hosted Linux computer with its own Chromium browser. That browser has none of Rodney's sign-ins, egresses from an unfamiliar network/IP, and has no access to the passkeys on Rodney's devices. Three mismatches — **session, network, hardware keys** — cause real, repeated failures:

- GitHub sign-in is passkey-based; the agent browser cannot sign in, so repo creation and repo settings changes are impossible from Squish's side (verified repeatedly, Oct–Nov 2026).
- Google sign-in from the agent's network triggered a 48-hour security hold (NotebookLM ingestion, Nov 2026).
- File uploads over ~128 KB cannot be pushed through the GitHub connector's text route; the natural fix (drag-and-drop in a signed-in browser) is unavailable.
- Kaggle milestone-notebook publication must happen in the Kaggle web UI under Rodney's account.

The Muse team has been sent a feature request for an official Windows app / Chrome extension (filed 2026-11-07). This project is the DIY version, buildable now, for Rodney's own machines and accounts.

## 2. Design principles

1. **The extension never touches credentials.** It drives Rodney's already-signed-in browser UI. It does not read cookies, passwords, or passkeys, and never asks for them. Authentication events (passkey prompts, 2FA) are completed by Rodney on his own devices, in his own browser, exactly as if he were clicking himself.
2. **Rodney designates the tab.** Control applies only to a tab Rodney explicitly shares. Nothing is driven in the background or in tabs he hasn't handed over.
3. **Rodney can always see and stop.** A persistent visible state while control is active, and a hard stop that works even if the bridge or Squish misbehaves.
4. **Allowlist, not open road.** The extension only operates on origins Rodney has approved. Everything else is refused at the extension, before any action runs.
5. **Every action is logged.** A complete, local audit trail of commands and results, inspectable by Rodney at any time.
6. **No third parties.** The bridge server runs on Squish's own computer. The extension talks to Squish and nothing else.

## 3. Architecture

Three components:

```
┌─────────────────────────┐        WSS (outbound)        ┌──────────────────────────┐
│  Rodney's Chrome        │ ───────────────────────────▶ │  Bridge server           │
│  ┌───────────────────┐  │   pairing token + commands   │  (on Squish's computer)  │
│  │ Squish Bridge ext │  │ ◀─────────────────────────── │                          │
│  │  - pairing        │  │   results, screenshots,      │  - pairing/token store   │
│  │  - allowlist      │  │   DOM snapshots              │  - session router        │
│  │  - CDP driver     │  │                              │  - audit log             │
│  │  - stop button    │  │                              └────────────┬─────────────┘
│  └─────────┬─────────┘  │                                           │ local API
│            │ chrome.debugger (CDP)                                  ▼
│  ┌─────────▼─────────┐  │                              ┌──────────────────────────┐
│  │ Shared tab        │  │                              │  Squish (agent)          │
│  │ (Rodney's session)│  │                              │  issues commands, reads  │
│  └───────────────────┘  │                              │  results, decides next   │
└─────────────────────────┘                              └──────────────────────────┘
```

### 3.1 Extension (Manifest V3, TypeScript or plain JS)

- **Background service worker** — owns the WebSocket to the bridge, pairing state, allowlist, session state, and the audit log. MV3 service workers idle out; use the standard keepalive pattern (periodic `chrome.alarms` + socket reconnect with backoff) and design commands to tolerate reconnects.
- **Popup UI** — pair/unpair, choose the shared tab, start/stop a control session, view the allowlist and the audit log, big STOP button.
- **CDP driver** — `chrome.debugger.attach(tabId, "1.3")` on the shared tab only; issues DevTools Protocol commands (§5) and returns results.
- **On-page indicator** — while a session is active, a content script draws a persistent colored border/banner on the shared tab ("Squish is driving this tab — click STOP in the extension to end"), so control is never invisible. (Chrome additionally shows its own "extension is debugging this browser" infobar while the debugger is attached; that is expected and is a feature, not a bug.)

### 3.2 Bridge server (Node.js or Python — builder's choice, stdlib-first)

Runs on Squish's computer. Responsibilities:

- **Pairing endpoint** — accepts a pairing code + install identity, issues a device token (store only a hash of it).
- **WebSocket endpoint** — the extension's single outbound connection; routes commands from Squish to the extension and results back.
- **Local command API** — a trusted-source-gated HTTP interface Squish uses to submit commands and await results (this is the seam Squish's tooling talks to).
- **Audit log** — append-only record: timestamp, command, target origin, result status. (No page content in the log beyond what a command explicitly returned.)

Reachability: the extension connects outbound, so no inbound ports are needed on Rodney's network. Preferred route is over the existing **Tailscale** tailnet (both Squish's computer and Rodney's laptop are members), keeping the bridge off the public internet entirely. Fallback: a WSS endpoint with the token as the only credential, if the tailnet route proves impractical.

> **Topology flip (2026-11-08, recorded at M5 sign-off):** Squish's hosted VM accepts no inbound tailnet connections (platform limit), so the bridge runs on **Rodney's laptop** instead of Squish's computer. The extension pairs locally on the laptop; Squish dials the bridge's tailnet address from the outside. Since v0.5 the bridge listens on all interfaces by default (no `SQUISH_BRIDGE_HOST` needed) and the admin API trusts loopback plus the whole tailnet range `100.64.0.0/10` (`SQUISH_BRIDGE_TRUSTED_IPS` still adds explicit IPs; `SQUISH_BRIDGE_TRUST_TAILNET=0` / `SQUISH_BRIDGE_HOST=127.0.0.1` tighten). Everything else in this document is unchanged — the socket is still the extension's single outbound connection, now to `127.0.0.1`/laptop-tailnet instead of Squish's machine.

### 3.3 Squish side

Squish submits commands through the bridge's local API and works from the returned screenshots/DOM snapshots — the same observe → act → verify loop used in Squish's own browser, now applied to the shared tab. Squish never receives, stores, or transmits Rodney's credentials (per principle 1, there is nothing to receive).

## 4. Pairing & authentication

No accounts, no OAuth, no third-party identity provider. (A Facebook-app login was considered and rejected: it would prove Rodney's identity to Facebook, not pair an extension to Squish.)

1. Rodney installs the extension and clicks **Pair**.
2. Squish generates a **one-time pairing code** (short-lived, ~10 minutes, shown in chat).
3. Rodney enters the code in the extension popup. The extension presents it to the bridge over WSS/TLS together with a freshly generated per-install keypair or random install secret.
4. The bridge exchanges the code for a **device token**, stores only its hash, and marks the code spent. The extension stores the token in `chrome.storage.local`.
5. Every subsequent connection authenticates with the token. **Unpair** in the popup (or a bridge-side revoke) kills it instantly; pairing again is always possible.

The token is the keys to a drivable browser, so: WSS/Tailnet only, hash-at-rest on the bridge, per-install (laptop and any future machine pair separately), and revocable from either side.

## 5. Control surface (v0 command set)

All commands act **only on the shared tab**, are **JSON messages** over the socket — `{id, type, payload}` → `{id, ok, result | error}` — and are executed via CDP:

| Command | CDP basis | Notes |
|---|---|---|
| `navigate` | `Page.navigate` | URL must match the allowlist (§6). |
| `screenshot` | `Page.captureScreenshot` | Primary "eyes"; returned to Squish as an image. |
| `dom_snapshot` | `Accessibility.getFullAXTree` / `DOM` | Structured page outline (roles, names, text) so Squish can target elements semantically, not by pixels alone. |
| `click` | `Input.dispatchMouseEvent` | By element reference from a snapshot, or coordinates from a screenshot. |
| `type` / `fill` | `Input.insertText`, `Input.dispatchKeyEvent` | For form fields. **Never** used for passwords/keys — see §6.4. |
| `press_key` | `Input.dispatchKeyEvent` | Enter, Tab, Escape, arrows, etc. |
| `scroll` | `Input.dispatchMouseEvent` (wheel) / `Page` | |
| `get_state` | `tabs` API + `Page.getNavigationHistory` | Current URL, title, load state. |
| `wait_for` | polling `dom_snapshot` | Wait until an element/text appears or a timeout hits. |
| `hover` | `Input.dispatchMouseEvent` | v0.4: mouse move without press (menus, tooltips). |
| `reload` / `back` / `forward` | `Page` | v0.4: navigation controls; empty history errors loudly. |
| `pdf` | `Page.printToPDF` | v0.4: page printout returned as base64. |
| `upload_file` | `DOM.setFileInputFiles` | v0.4: sets a file input to a user-named local path; the agent cannot browse the disk. |
| `evaluate` | `Runtime.evaluate` | v0.4, owner-approved: audited page JS (see the note below this table). |

**Deliberately excluded from v0, revisited in v0.4 with Rodney's explicit approval (2026-11-09):** page JavaScript arrives ONLY through the audited `evaluate` command — expression cap (20k chars), return-by-value cap (100k), no user gesture, page exceptions mapped to errors, and every call audit-logged WITH its expression (success and failure). Free-form `scripting.executeScript` stays excluded. Honest tradeoff, recorded here: `evaluate` runs with the page's own privileges, so it can read whatever page scripts can and return it — fenced as above, and the extension itself still holds no credential-adjacent permission.

## 6. Safety model

### 6.1 Session control
- Control exists only inside an explicit session: Rodney presses **Connect & Share** on the tab he wants driven (v0.4 one-button flow: connect + full-site control + share + start); the popup and the on-page banner show the active state continuously; **Stop** (popup button, and a keyboard shortcut) detaches the debugger and ends the session immediately.
- One shared tab at a time in v0. Switching tabs requires a new explicit share — except tabs the shared page opens itself (OAuth popups, `target=_blank` links), which the session auto-follows from v0.4: still one tab, still policy-gated, always audit-logged (`follow-tab`). A child that fails the gate is left alone for explicit sharing.

### 6.2 Allowlist
- The extension holds an origin allowlist, editable only from the popup by Rodney. Commands whose target origin is not on the list are **refused by the extension** and logged.
- Initial list (missions in §8, plus later additions): `github.com`, `kaggle.com`, `notebooklm.google.com`, `notebook.google.com`, `supabase.com`, `app.supabase.com`.
- **Open Mode (v0.3, off by default, popup toggle):** skips the allowlist step so any `https://` non-denylisted origin is shareable with zero setup. Everything else in §6 still applies — explicit shared tab, banner + STOP, per-site banner grant (MV3 only grants origins covered by a manifest pattern, so the manifest carries one optional `https://*/*` that grants nothing until the user accepts a per-origin prompt), audit log, no credentials. The toggle itself is audit-logged.
- A default **denylist** always wins over the allowlist: banking/financial origins, password-manager pages, and `chrome://` / extension pages (which Chrome won't let extensions drive anyway).

### 6.3 Audit
- Every command and its outcome is written to the local audit log (extension) and the bridge log. Rodney can open the log from the popup at any time. No silent actions exist.

### 6.4 Credential hygiene
- The extension requests **no** `cookies` permission and no access to password stores. It cannot read Rodney's credentials and is designed so it never needs to.
- If a driven page presents a login, passkey, or 2FA prompt, Squish stops and Rodney completes it himself — after which the session simply continues, now signed in. This is the intended flow, not a failure.
- Bridge tokens, pairing codes, and any keys live in the same discipline as the rest of the fleet: never in git, never in chat after the moment of use, revocable.

### 6.5 Failure behaviour
- Socket drop, bridge unreachable, or extension crash ⇒ session is over; the debugger detaches; nothing retries silently in the background.
- A command that would navigate away from an allowlisted origin is refused before it runs.

## 7. Permissions (MV3 manifest) — each justified

| Permission | Why |
|---|---|
| `debugger` | The CDP driver (§5). The powerful one; justified by the whole design, fenced by §6. |
| `tabs` | Identify and track the shared tab; read URL/title for state and allowlist checks. |
| `storage` | Pairing token, allowlist, settings, audit log. |
| `alarms` | Service-worker keepalive / reconnect scheduling. |
| `scripting` | Inject the on-page "Squish is driving" banner only. Not for arbitrary page code (§5 exclusion). |
| `optional_host_permissions` | Requested per allowlisted origin at the time Rodney adds it — never a blanket `<all_urls>` up front. |

**Not requested:** `cookies`, `history`, `downloads`, `webRequest`, or any credential-adjacent API.

## 8. v0 scope

**In scope**
- Pairing flow (§4) over the Tailscale route; token revoke/unpair.
- Single shared tab; start/stop sessions; on-page banner + popup state.
- The §5 command set (no arbitrary JS eval).
- Allowlist with the §6.2 initial origins + denylist; popup editing.
- Audit log (extension + bridge).
- Bridge server with loopback command API for Squish.

**Out of scope (v0)**
- Multi-tab or background/unattended control.
- Arbitrary JavaScript evaluation in the page.
- Other browsers (Firefox/Safari), mobile Chrome, or a public-internet bridge without the token discipline of §4.
- Any handling of credentials, cookies, or autofill data.
- Publishing to the Chrome Web Store (sideload / developer mode is fine for personal use).

**Acceptance missions (v0 is done when these pass)**
1. **GitHub repo creation** — in Rodney's signed-in Chrome, create a new empty repo under his account with Squish driving and Rodney watching; the exact task that is impossible today.
2. **NotebookLM open** — open a shared notebook in Rodney's session (no security hold, because the request genuinely comes from his browser/network) and read its contents back to Squish.
3. **Stop drill** — Rodney hits STOP mid-session; control ends immediately and the log shows it.

## 9. Build order (milestones)

- **M0 — Scaffold:** repo layout (`extension/`, `bridge/`, `docs/`), MV3 manifest with §7 permissions, popup skeleton, bridge skeleton with health endpoint.
- **M1 — Pairing:** code exchange, token issue/hash/store, unpair/revoke, WSS connect + reconnect.
- **M2 — Eyes:** attach debugger to a designated tab; `navigate`, `screenshot`, `dom_snapshot`, `get_state` round-trip Squish → bridge → extension → result.
- **M3 — Hands:** `click`, `type`/`fill`, `press_key`, `scroll`, `wait_for`.
- **M4 — Safety:** allowlist enforcement, denylist, banner, STOP (button + shortcut), audit log viewer.
- **M5 — Missions:** run §8 acceptance missions 1–3; write up results honestly, including anything that failed.

## 10. Open decisions (Rodney)

1. **Name** — "Squish Bridge" is a working title.
2. **Repo** — create `Sir-Ripley/SquishBridge` (or chosen name) when ready; Squish cannot create repos (the very limitation this project removes). Until then, this design lives in Squish's workspace and Rodney's files.
3. **Bridge language** — Node or Python; either is fine, stdlib-first.
4. **Tailnet route** — confirm the laptop's Tailscale address is stable for the bridge endpoint config.

---

## Appendix — Onboarding brief for Muse Code (first task)

You are building **Squish Bridge** from this design document, on Rodney's Windows laptop, inside this repository. Context you do not have: Squish (Rodney's Muse agent) works from a separate hosted computer and cannot see this machine; Rodney pastes your output back to Squish when something needs review, and Squish verifies every push from the repo. Work to the design, not around it:

- Build in the milestone order (§9). Do not skip the safety milestone (M4) to reach the missions sooner.
- The §6 safety model is a hard requirement, not polish: explicit shared tab, allowlist enforced in the extension, visible banner, working STOP, audit log, no `cookies` permission, no arbitrary JS evaluation in v0.
- Plain, dependency-light code wins. TypeScript is welcome; a framework is not needed for the popup.
- After each milestone: commit with a message naming the milestone, push, and summarize what works and what doesn't in plain language for Rodney to relay.
- If the design and the platform disagree (e.g., an MV3 limitation), stop and surface it rather than quietly redesigning — Rodney will arbitrate with Squish.
