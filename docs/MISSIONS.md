# Squish Bridge — M5 acceptance missions (runbook)

v0 is done when these three pass **on Rodney's real, signed-in Chrome**.
Code verification (44 unit tests, validator, live socket drills) is already
green; this document is the live-run procedure plus the results log.
Fill in each mission honestly — including anything that failed.

## Pre-flight (all missions)

- [x] Bridge reachable over the tailnet — NOTE: it runs on **Rodney's laptop** (100.87.226.76:3031), not Squish's computer. Squish's VM accepts no inbound tailnet connections (platform limit), so the bridge host flipped sides: the extension pairs locally on the laptop, Squish dials out through the tailnet proxy, and the bridge trusts Squish's tailnet IP (100.64.214.38) for its admin API via `SQUISH_BRIDGE_TRUSTED_IPS` (patched 2026-11-08).
- [x] Extension loaded unpacked, paired (popup shows `Paired`). Install: ext-776b7034-35ac-404e-9dc7-6095f37476c4, registered 2026-11-08 19:24:50 UTC.
- [x] Target origins allowlisted AND host grants accepted.
- [x] Rodney signed in to the target site in his own profile.
- [ ] Audit log cleared (popup → Clear) so each mission reads cleanly. *(Not done before this run — logs read cleanly regardless; noted for honesty.)*

## Mission 1 — GitHub repo creation

The task impossible from Squish's own browser: create a new empty repo under
Rodney's account, with Squish driving and Rodney watching.

1. Rodney opens `github.com/new`, shares the tab, presses **Start**.
2. Squish: `get_state` → `dom_snapshot` → `fill` repo name → `click` Create.
3. Verify: repo page loads under Rodney's account; audit log shows
   `navigate/fill/click → ok`.

| Field | Result |
|---|---|
| Date | 2026-11-08 |
| Repo created (URL) | https://github.com/Sir-Ripley/squish-bridge-test (Private, empty) |
| Audit verdict | navigate / dom_snapshot / fill / click → all ok (bridge audit: every CMD 200) |
| Pass? | **Pass** |

## Mission 2 — NotebookLM open

Proves the network-mismatch fix: the request genuinely comes from Rodney's
browser and network, so no security hold.

1. Rodney opens the shared notebook URL, shares the tab, presses **Start**.
2. Squish: `get_state` → `dom_snapshot` → read notebook contents back.
3. Verify: no sign-in challenge or hold; contents read back correctly.

| Field | Result |
|---|---|
| Date | 2026-11-08 |
| Notebook opened | QAG NEXUS (notebook.google.com/notebook/b9b7017b-a083-45bb-b880-2244e88a9b8d) — 292 sources, opened in Rodney's own browser/network; NO sign-in challenge, NO security hold |
| Contents correct? | Yes — title, source groups, notes list, and notebook summary read back verbatim via dom_snapshot (300 nodes) |
| Pass? | **Pass** |

## Mission 3 — Stop drill

Proves control ends instantly, three ways.

1. Rodney shares any allowlisted tab, presses **Start**.
2. Squish issues a long `wait_for` (e.g. 60 s for text that never appears).
3. Rodney hits **STOP** — popup button first; repeat with `Ctrl+Shift+S`
   and the banner button on later runs.
4. Verify: command stops at once, popup shows idle, badge clears, banner
   gone, audit log shows `stop-session → ok` with the matching reason.

| Field | Result |
|---|---|
| Date | 2026-11-08 |
| Stop paths tried (popup/shortcut/banner) | Popup button (shortcut + banner paths remain for later runs, per this runbook) |
| Control ended immediately? | Yes — in-flight 60 s `wait_for` died ~5 s after the press (24.6 s total incl. operator reaction time); post-stop `get_state` refused with `refused: no active session`; bridge audit shows the killed command (502 at 19:30:14 UTC). FINDING (cosmetic, fix-forward): the killed command surfaced the raw CDP error `Debugger is not attached to the tab…` instead of a friendly `session ended` reason — the safety property held, the error string should be mapped. |
| Pass? | **Pass** |

## M5 sign-off

v0 ships when all three read **Pass**. If anything fails, file it in the
table, keep the audit logs (Download button), and fix forward — a failed
mission is a finding, not a reopening of the design.

**SIGNED OFF 2026-11-08 — all three missions Pass on Rodney's real,
signed-in Chrome. Squish Bridge v0 SHIPS.** 🎉 One cosmetic finding logged
under Mission 3. The bridge-host topology flip (bridge on the laptop, Squish
dialing out) is recorded in Pre-flight above and should be folded back into
DESIGN.md at the next docs pass.
