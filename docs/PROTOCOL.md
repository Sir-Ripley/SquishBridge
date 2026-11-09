# Squish Bridge — Wire Protocol (v0, M0)

All commands act **only on the shared tab** and travel as JSON messages
over the extension's single outbound socket:

- Extension → bridge (results) and bridge → extension (commands) share one envelope.
- Squish talks to the bridge's loopback-only HTTP API, which forwards over the socket.

## Envelopes

Command: `{ "id": "<uuid>", "type": "<command>", "payload": { … } }`

Result: `{ "id": "<same uuid>", "ok": true, "result": { … } }`
or: `{ "id": "<same uuid>", "ok": false, "error": "<machine-readable reason>" }`

`error` values are stable strings (`origin not allowlisted`, `denylisted origin`,
`missing-url`, `bad-url`, `origin must be https`, session errors, …) so the
agent can branch on them. Human detail goes in the audit log, not the error.

## Pairing (M1)

No fetch, no host permission: the whole exchange runs over the socket.

1. Squish mints a code over loopback: `POST /v1/pair/code` → `{ ok, code, expiresAt }`
   (8 unambiguous chars, 10-minute TTL, single-use, burns on misuse).
2. Extension opens `ws(s)://<bridge>/v1/extension` and sends
   `{ id, type: "pair", payload: { code, installId } }` →
   `{ id, ok, result: { token, installId } | error }`.
3. Extension authenticates on the same socket:
   `{ id, type: "auth", payload: { token, installId } }` →
   `{ id, ok, result: { hello, version } }`. The socket stays open;
   drops reconnect with exponential backoff (1s → 60s cap, jitter).
4. Unpair is local (token deleted); Squish revokes bridge-side via
   `POST /v1/devices/revoke`, which also closes the live socket (4403).
   A rejected token (4401) clears pairing on the extension automatically.

Only token hashes rest on the bridge (`devices.json`); raw tokens never
touch disk, and `GET /v1/devices` never exposes hashes.

## v0 command set

| Command | Payload | Result | Milestone |
|---|---|---|---|
| `navigate` | `{ url }` | `{ url, title }` | M2 |
| `screenshot` | `{}` | `{ pngBase64 }` | M2 |
| `dom_snapshot` | `{}` | `{ snapshot }` | M2 |
| `click` | `{ ref }` or `{ x, y }` | `{ clicked }` | M3: scrolls into view, clicks the quad center. Stale refs refuse — re-snapshot. |
| `type` / `fill` | `{ ref, text }` | `{ typed }` | M3: focus + insert; `fill` select-alls first (replace, never append). |
| `press_key` | `{ key }` | `{ pressed }` | M3: single char or Enter/Tab/Escape/Arrows/Backspace/Delete/Home/End/PageUp/PageDown. |
| `scroll` | `{ ref?, dx?, dy? }` | `{ scrolled }` | M3: wheel at the ref center, else viewport center; `dy` defaults to 400. |
| `get_state` | `{}` | `{ url, title, loading }` | M2 |
| `wait_for` | `{ text?, ref?, timeoutMs? }` | `{ found }` | M3: polls snapshots every 500 ms (default 10 s, max 60 s); timeout is an error. |
| `list_tabs` | `{}` | `{ tabs: [{ tabId, title, origin, shared, drivable }] }` | v0.3: needs NO active session (that is the point — discover tabs, then ask the user to share one). Metadata only: origins, never full URLs. Never attaches the debugger. |
| `hover` | `{ ref }` or `{ x, y }` | `{ hovered }` | v0.4: moves the mouse without pressing (menus, tooltips). |
| `reload` | `{ ignoreCache? }` | `{ reloaded }` | v0.4 |
| `back` / `forward` | `{}` | `{ navigated }` | v0.4: history walk; empty history is an error, not silent. |
| `pdf` | `{}` | `{ pdfBase64 }` | v0.4: prints the page (background graphics on). |
| `upload_file` | `{ ref, path }` | `{ uploaded, file }` | v0.4: sets a form's file input to a user-named local path (`C:\…`). The agent cannot browse the disk — the user names the file in chat. The filename is audit-logged. |
| `evaluate` | `{ expression, awaitPromise? }` | `{ value }` | v0.4, approved 2026-11-09: runs JS in page context. Expression cap 20k chars, return-by-value cap 100k chars, page exceptions mapped to errors, `undefined` comes back `null`. Every call is audit-logged WITH its expression. |

v0.4 extensions to older commands: `click` takes `{ button: left\|middle\|right, clickCount: 1-3 }`; `press_key` takes `{ alt?, ctrl?, meta?, shift? }` for chords (`Ctrl+C`); `screenshot` takes `{ fullPage? }`.

> `evaluate` runs with the page's own privileges: it can read whatever page
> scripts can (DOM, page storage, non-httpOnly cookies) and hand it back as
> its return value. That is a deliberate, owner-approved widening of the v0
> "no page code" rule — fenced by the expression/result caps, the ban on
> user gestures, and the always-logged expression. It still cannot touch
> `httpOnly` cookies, passwords, or passkeys, and the extension itself keeps
> no credential-adjacent permission.

## Sharing upgrades (v0.3)

- **Share this site** (popup button, extension-local): allowlists the current
  tab's origin if needed (with the usual host-grant prompt), designates the
  tab, and starts the session — one click instead of add → share → start.
- **Open Mode** (popup toggle, off by default): skips the allowlist check so
  any `https://` non-denylisted origin can be shared with zero setup. The
  denylist, the https rule, the per-site banner grant, the banner/badge/STOP,
  and the audit log all still apply. The toggle itself is audit-logged.

Still excluded: free-form `scripting.executeScript`. Page JS arrives only
through the audited `evaluate` command above — never as injected scripts.

## Safety order (extension-enforced, before any CDP runs)

1. Session active with an explicitly shared tab? If not, refuse.
   (`list_tabs` is exempt: read-only metadata, no CDP, no page access.)
2. `sbCheckUrl` on the target URL: https → denylist → allowlist
   (Open Mode skips the allowlist step only).
3. Refusals are returned as `{ ok: false, error }` **and** audit-logged.
