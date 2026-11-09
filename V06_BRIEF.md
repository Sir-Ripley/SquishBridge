# Squish Bridge v0.6 Brief — field report from the 2026-11-08 Supabase marathon

**From:** Squish (via a full evening of production use: Supabase + Vercel + GitHub
settings, workflow activation, Kaggle staging)
**For:** Rodney + Muse Code (bridge maintainers)
**Status of v0.5:** SHIPPED and battle-proven. The bridge carried: two Supabase
projects audited, Vercel env vars set (one via clipboard-carry), a production
redeploy, a GitHub repo variable created, a workflow file created **and
committed by the bridge itself**, and a manual workflow dispatch.

## Already delivered since the original wishlist — thank you, keep these

- Wildcard host permissions path works (supabase.com / vercel.com grants succeeded
  after the manifest fix).
- Child-frame interaction works: the bridge clicked GitHub's final **Commit
  changes** button (commit `8e2c8dc2` landed under Rodney's session). The old
  conveyor-era "Rodney must click Commit" limitation is gone.
- `press_key` chords (Ctrl+V) enabled the clipboard-carry secret pattern.
- `evaluate`, `upload_file`, `list_tabs` all present.

## P0 — correctness/trust fixes (observed failures, with repro)

1. **False-failure action results.** During the GitHub workflow commit, `fill`
   on the commit-message field returned `Element is not focusable`, then
   `click` on Commit returned `Node is detached from document` — while the
   commit had in fact **succeeded** (page navigated, file live, md5 verified
   by read-back). An agent acting on those errors would retry a commit that
   already landed.
   *Ask:* `fill`/`click` auto-wait until the target is stable + focusable
   (bounded, e.g. 5 s, retrying the ref resolution); every action result
   includes `url_after` and a `navigated: bool` so success is distinguishable
   from failure without a follow-up snapshot.
2. **Server bind footgun.** `bridge/server.js` defaults `SQUISH_BRIDGE_HOST`
   to `127.0.0.1`; a plain restart silently binds loopback-only — the
   extension looks healthy locally while Squish's tailnet commands get empty
   replies. This cost ~30 minutes of the marathon.
   *Ask:* server reads a persisted config (`bridge/bridge.config.json` or
   `.env`) for host/trusted IPs; startup prints both the loopback and
   tailnet URLs and which interfaces it bound; `npm start` uses the config
   by default.
3. **Two-light popup status.** The popup cannot distinguish "extension ↔
   server OK" from "server reachable from Squish" — during the bind failure
   both looked identical from Rodney's side.
   *Ask:* two indicators: (a) extension↔server socket state; (b) server's
   `last_command_at` age (server tracks it; popup polls `/health`), labelled
   "Squish link: active 12s ago / silent 22m".
4. **Pairing should survive restarts.** After the server relaunch, a fresh
   one-time pair code was required.
   *Ask:* persist device tokens + pairing state to disk (server data dir),
   restore on boot; only re-pair on explicit revoke.

## P1 — capability gaps hit in real tasks

5. **Snapshot node cap (300) truncates real pages.** Vercel's deployments
   list saturates the cap; elements past it are unreachable by ref.
   *Ask:* either raise + paginate snapshots (`offset`), or add a server-side
   `find` command: `{role?, text_contains?}` → returns only matching refs.
   `find` is the better primitive for agents.
6. **No settle-aware navigation.** SPA routes (Supabase/Vercel dashboards)
   render after `navigate` returns; the agent currently guesses `sleep`
   durations, and early snapshots come back near-empty.
   *Ask:* `navigate` waits for load + a quiet window (no DOM mutations for
   ~500 ms, bounded 10 s) and reports `settled: bool`; `dom_snapshot`
   gains `min_nodes` retry-until behaviour.
7. **Batch command endpoint.** Multi-step forms (fill + fill + click) take
   one tunnel round-trip each and can each trigger a fresh proxy approval.
   *Ask:* `POST /v1/commands/batch` accepting an ordered array, executed
   sequentially server-side, returning per-step results; stop-on-error flag.
8. **Audit introspection endpoint.** After a dropped connection
   (`RemoteDisconnected` hit twice), the agent cannot tell what the server
   last executed.
   *Ask:* `GET /v1/audit?limit=N` returning the recent command log (type,
   timestamp, ok/error — never payload values for fill/type; lengths only).
9. **`select` primitive** for native `<select>` and ARIA listboxes (Vercel's
   environment-scope control, GitHub selects). Current workaround is
   click-and-hope on the rendered button label.

## P2 — the one new feature that changes the security game

10. **`generate_and_fill` (extension-side secret generation).** Last night's
    `AESTHERIA_PACKET_SECRET` flow worked (Squish generated → bridge fill →
    Vercel), but the value transited agent-side tooling. Better: a bridge
    command `{type: "generate_and_fill", ref, bytes: 32}` where the
    **extension** generates the secret with `crypto.getRandomValues`, fills
    the field, and returns only `{length, sha256_fingerprint}`. The secret
    then exists in exactly one place — the target service — and in no log,
    transcript, clipboard, or agent memory. Same pattern would serve repo
    secrets and API tokens. This strengthens the bridge's founding rule:
    *the bridge never touches credentials — and now neither does the agent.*

## Invariants — do not regress

- No `cookies` permission, ever.
- Allowlist + denylist enforced **in the extension**; banner + hard STOP on
  every shared tab.
- One shared tab at a time; user-designated only.
- No arbitrary JS eval exposed to the agent beyond the existing capped
  `evaluate` (expression/result limits stay).
- Audit log append-only; fill/type payloads logged as lengths, not values
  (extends naturally to the new `/v1/audit` endpoint).

## Suggested acceptance missions for v0.6

1. Restart drill: kill + relaunch server with no env vars → extension
   reconnects without a new pair code; popup shows both status lights green.
2. Commit-race drill: repeat the GitHub new-file commit; the agent receives
   unambiguous success (navigated=true) with zero false-failure errors.
3. Secret drill: `generate_and_fill` a Vercel env var; verify the fingerprint
   matches the value's hash as shown by the target service, and grep every
   log/transcript surface to prove the value appears nowhere.
4. Long-page drill: on a 500+ node page, `find` returns a ref beyond the old
   300-node horizon and the click lands.
