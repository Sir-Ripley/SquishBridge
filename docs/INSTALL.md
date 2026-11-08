# Squish Bridge — Install guide (Rodney's laptop)

Chrome extensions are not compiled. The `extension/` folder **is** the app;
you load it unpacked, and the M5 zip (`dist/`) is the same folder zipped.

## 1. Prerequisites

- Chrome (version 120+) on the laptop with your signed-in profile.
- The repo checked out at the commit you want to run.
- Your Tailscale tailnet address for the bridge (Squish gives you the exact
  `ws://…:3031` value when you pair).

## 2. Validate (optional but recommended)

```
node tools/validate.js
```

Exit 0 with `READY: extension is installable.` means the manifest, file
references, permission set, forbidden-API sweep, and artifact check all pass.

## 3. Load the extension

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. **Load unpacked** → select the `extension/` folder.
4. Pin the extension (puzzle icon → pin) so STOP is one click away.

After `git pull`, click the extension card's reload button. No reinstall,
no store, no account needed.

## 4. Start the bridge (Squish's computer)

```
cd bridge
npm install   # once; installs the single dependency (ws)
npm start     # serves http://127.0.0.1:3031, or the tailnet IP via SQUISH_BRIDGE_HOST
```

## 5. Pair (once per browser)

1. Squish mints a one-time code: `POST /v1/pair/code` (10-minute life).
2. Open the popup, enter the bridge address (`ws://<tailnet-ip>:3031`)
   and the code, click **Pair**.
3. Chrome asks for host access per origin as you add allowlist entries —
   grant it, or the safety banner cannot render and the add is refused.
4. The popup shows `Paired`. Reloading or restarting keeps the pairing;
   **Unpair** (popup) or bridge-side revoke ends it instantly.

## 6. Drive a tab

1. Open the tab you want to share (must be on an allowlisted origin).
2. Popup → **Share this tab** → **Start**. The yellow banner appears and
   the toolbar badge reads ON. Chrome also shows its own "debugging this
   browser" infobar — expected.
3. Squish drives via `POST /v1/commands`. You watch; sign in yourself if a
   login appears (the agent stops and waits — that is the design, not a bug).
4. **STOP** any time: popup button, `Ctrl+Shift+S`, or the banner's STOP.

## Troubleshooting

| Symptom | Cause → fix |
|---|---|
| Pair fails "cannot reach bridge" | Wrong address/port, or bridge not running → check `npm start` and the tailnet IP. |
| "pairing refused: code-expired / unknown-or-spent" | Code older than 10 min or already used → ask Squish for a fresh one. |
| Allowlist add "permission denied" | Host grant declined → re-add and Accept so the banner can show. |
| Banner missing but session active | Host permission revoked → re-add the origin; the debugger infobar still shows control meanwhile. |
| `no-device-connected` from `/v1/commands` | Extension socket down → popup shows state; check pairing and tailnet. |
| `attach-failed` on Start | Another debugger (DevTools, another extension) holds the tab → close it, Start again. |
| Command `refused: origin not allowlisted` | Tab drifted off the allowlist → navigate back or add the origin first. |
| Socket drops repeatedly | Tailnet route flapping → the extension backs off and reconnects on its own; check tailnet status. |

## Safety reminders

- Credentials are never read or shared: no `cookies` permission exists, and
  the validator fails the build if one ever appears.
- One shared tab at a time. Nothing runs in the background.
- Both audit logs are inspectable: popup viewer + Download, and bridge
  `GET /v1/audit` (loopback-only).
