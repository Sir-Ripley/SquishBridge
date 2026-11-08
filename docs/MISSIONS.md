# Squish Bridge — M5 acceptance missions (runbook)

v0 is done when these three pass **on Rodney's real, signed-in Chrome**.
Code verification (44 unit tests, validator, live socket drills) is already
green; this document is the live-run procedure plus the results log.
Fill in each mission honestly — including anything that failed.

## Pre-flight (all missions)

- [ ] Bridge running on Squish's computer, reachable over the tailnet.
- [ ] Extension loaded unpacked, paired (popup shows `Paired`).
- [ ] Target origins allowlisted AND host grants accepted.
- [ ] Rodney signed in to the target site in his own profile.
- [ ] Audit log cleared (popup → Clear) so each mission reads cleanly.

## Mission 1 — GitHub repo creation

The task impossible from Squish's own browser: create a new empty repo under
Rodney's account, with Squish driving and Rodney watching.

1. Rodney opens `github.com/new`, shares the tab, presses **Start**.
2. Squish: `get_state` → `dom_snapshot` → `fill` repo name → `click` Create.
3. Verify: repo page loads under Rodney's account; audit log shows
   `navigate/fill/click → ok`.

| Field | Result |
|---|---|
| Date | |
| Repo created (URL) | |
| Audit verdict | |
| Pass? | |

## Mission 2 — NotebookLM open

Proves the network-mismatch fix: the request genuinely comes from Rodney's
browser and network, so no security hold.

1. Rodney opens the shared notebook URL, shares the tab, presses **Start**.
2. Squish: `get_state` → `dom_snapshot` → read notebook contents back.
3. Verify: no sign-in challenge or hold; contents read back correctly.

| Field | Result |
|---|---|
| Date | |
| Notebook opened | |
| Contents correct? | |
| Pass? | |

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
| Date | |
| Stop paths tried (popup/shortcut/banner) | |
| Control ended immediately? | |
| Pass? | |

## M5 sign-off

v0 ships when all three read **Pass**. If anything fails, file it in the
table, keep the audit logs (Download button), and fix forward — a failed
mission is a finding, not a reopening of the design.
