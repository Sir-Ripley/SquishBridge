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

## v0 command set

| Command | Payload | Result | Milestone |
|---|---|---|---|
| `navigate` | `{ url }` | `{ url, title }` | M2 |
| `screenshot` | `{}` | `{ pngBase64 }` | M2 |
| `dom_snapshot` | `{}` | `{ snapshot }` | M2 |
| `click` | `{ ref }` or `{ x, y }` | `{ clicked }` | M3 |
| `type` / `fill` | `{ ref, text }` | `{ typed }` | M3 |
| `press_key` | `{ key }` | `{ pressed }` | M3 |
| `scroll` | `{ ref?, dx?, dy? }` | `{ scrolled }` | M3 |
| `get_state` | `{}` | `{ url, title, loading }` | M2 |
| `wait_for` | `{ text?, ref?, timeoutMs? }` | `{ found }` | M3 |

Deliberately excluded from v0: arbitrary JavaScript evaluation
(`Runtime.evaluate`, free-form `scripting.executeScript`). See DESIGN §5.

## Safety order (extension-enforced, before any CDP runs)

1. Session active with an explicitly shared tab? If not, refuse.
2. `sbCheckUrl` on the target URL: https → denylist → allowlist.
3. Refusals are returned as `{ ok: false, error }` **and** audit-logged.
