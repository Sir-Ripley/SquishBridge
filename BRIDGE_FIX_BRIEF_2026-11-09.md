# Bridge outage 2026-11-09 — diagnostic brief for Muse Code (laptop)

*From Squish (remote side). Rodney has run the relaunch steps repeatedly;
they do not fix it. Do not hand them back to him. Diagnose on the laptop,
where the evidence actually lives.*

## Symptom (verified from Squish's side, repeatedly, 11:02–11:35 EST)

- Squish's tunnel probes to `http://100.87.226.76:3031/health` and
  `POST /v1/commands` die at ~8.1 s with an EMPTY reply
  (curl rc=52 / RemoteDisconnected). No approval request registers.
- `tailscale status` (Squish VM): enrolled; exactly one peer =
  the laptop at 100.87.226.76 (address unchanged all weekend).
- Direct TCP from the VM sandbox is refused by policy (expected —
  only the tunnel proxy path is sanctioned, and that path worked
  yesterday and once today).

## Timeline

- 2026-11-08 evening: bridge v0.5.0 worked for hours (Supabase/Vercel/
  GitHub work all landed through it).
- 2026-11-09 10:56 EST: `get_state` SUCCEEDED (shared tab = AI-Offline
  Actions page). Sometime between then and 11:02 it stopped answering
  and has not answered since, across multiple server restarts.
- The extension popup has shown "connected/shared" throughout —
  which proves only that the extension reaches SOMETHING locally.

## What is NOT established (stop assuming)

- That the running server is bound to the tailnet address. Nobody has
  read the actual startup line off the laptop console today.
- That the laptop's running copy matches repo HEAD. NOTE: repo HEAD
  `bridge/server.js` carries the comment "Bind everywhere by default"
  near the top — while the field diagnosis all weekend assumed
  `SQUISH_BRIDGE_HOST || 127.0.0.1`. DIFF the laptop checkout against
  HEAD first; a stale or locally-edited build explains everything,
  including "it worked yesterday" (different process, different bind).

## Checklist (in order)

1. `git -C <SquishBridge clone> status` + diff `bridge/server.js`
   against HEAD. Report any local drift verbatim.
2. In the server's console: capture the EXACT startup listening line.
3. On the laptop itself: `curl http://127.0.0.1:3031/health` and
   `curl http://100.87.226.76:3031/health` — compare. If loopback
   answers and the tailnet address doesn't, it's bind/firewall.
4. Windows Firewall: is node.exe allowed on the tailnet interface /
   Private profile? A firewall rule change (or network profile flip
   Public<->Private) silently produces exactly this symptom:
   local OK, tailnet dead, extension "connected".
5. Extension popup: read the configured bridgeUrl verbatim
   (must be ws://100.87.226.76:3031) — a revert to 127.0.0.1 also
   produces this exact picture.
6. Check the server audit log for Squish's probe attempts: if the
   probes never appear, traffic isn't reaching the process at all.

## The durable fix (already specified — implement it)

V06_BRIEF.md P0: persisted server config (host written to a config
file on first run; startup prints and VERIFIES its bind against the
tailnet interface), so this failure class cannot recur silently.
While you're in there: pairing persistence across restarts (also P0)
— Rodney had to re-pair today because of this outage.

Report back: which checklist item it was, with the evidence line.
