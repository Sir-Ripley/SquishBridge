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

Deliberately excluded from v0: arbitrary JavaScript evaluation
(`Runtime.evaluate`, free-form `scripting.executeScript`). See DESIGN §5.

## Safety order (extension-enforced, before any CDP runs)

1. Session active with an explicitly shared tab? If not, refuse.
2. `sbCheckUrl` on the target URL: https → denylist → allowlist.
3. Refusals are returned as `{ ok: false, error }` **and** audit-logged.
