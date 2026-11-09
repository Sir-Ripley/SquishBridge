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

## 4. Start the bridge (this laptop)

```
cd bridge
npm install                                        # once; installs the single dependency (ws)
powershell -ExecutionPolicy Bypass -File ..\tools\bridge.ps1 start    # runs in the background
```

That prints the `ws://…:3031` addresses — hand the tailnet one to Squish
so it can dial in from its side. `bridge.ps1 status` reprints them any
time (`GET /v1/status` reports them too, as `addrs`); `bridge.ps1 stop`
ends it. Prefer a foreground terminal? `npm start` in `bridge/` instead —
same server, dies with the window.

No address configuration is needed: since v0.5 the bridge listens on all
interfaces out of the box (loopback for the extension, tailnet/LAN for
the agent). Reachability is not access — minting codes and submitting
commands still require a trusted source: loopback plus your whole tailnet
range `100.64.0.0/10` (agent IPs rotate; tailnet membership is the real
boundary). Tighten with `SQUISH_BRIDGE_TRUST_TAILNET=0` (explicit
`SQUISH_BRIDGE_TRUSTED_IPS` only) or `SQUISH_BRIDGE_HOST=127.0.0.1`
(loopback only, agent locked out).

Since v0.6 the server persists this in `bridge/bridge.config.json`
(created with defaults on first boot; `npm start` uses it with zero env
vars), and every startup verifies the bind against the real interfaces —
a loopback-only bind on a tailnet machine prints a `WARNING` naming the
fix instead of failing silently. Precedence: env vars > config file >
defaults.

## 4b. Autostart (so nobody runs commands by hand)

The bridge should survive reboots and crashes with no terminal:

- A **Startup shortcut** (`SquishBridge.lnk` in the Windows Startup folder)
  runs `tools/bridge.ps1 start` at every logon.
- A **watchdog task** (`SquishBridge-Watchdog`, every 15 min) re-runs the
  same start, which is a no-op when the bridge is already healthy.

Recreate them any time (no admin needed):

```
schtasks /Create /TN SquishBridge-Watchdog /TR "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File <repo>\tools\bridge.ps1 start" /SC MINUTE /MO 15 /F
```

plus a `SquishBridge.lnk` shortcut in
`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup` with the same
target. Check health with `tools/bridge.ps1 status`
(or `GET /health`); logs live in `bridge/bridge.log`.

> **Agents, read this before telling Rodney to restart anything.** The ONLY
> supported restart is `tools/bridge.ps1 restart` from the repo root (the
> repo lives wherever Rodney cloned it — check `Get-Location`, never assume
> `$HOME\SquishBridge`). Do NOT set `SQUISH_BRIDGE_HOST` to the tailnet IP:
> that binds tailnet-only and breaks the loopback-paired extension. Do NOT
> run bare `node server.js` in a terminal: it dies with the window and
> bypasses the pidfile/health check. If probes get empty replies, the
> server is down — check `bridge.ps1 status` first, not the firewall.

## 5. Pair (once per browser)

1. Squish mints a one-time code: `POST /v1/pair/code` (10-minute life).
2. Open the popup — the bridge address is prefilled with
   `ws://127.0.0.1:3031` (the bridge runs on this laptop). Enter the code,
   click **Pair**.
3. Chrome asks for host access per origin as you add allowlist entries —
   grant it, or the safety banner cannot render and the add is refused.
4. The popup shows `Paired`. Reloading or restarting keeps the pairing;
   **Unpair** (popup) or bridge-side revoke ends it instantly.

## 6. Drive a tab

1. Open the tab you want to share (any real `https://` site — not a new-tab
   or `chrome://` page, which Chrome won't let extensions drive).
2. Popup → **Connect & Share**. One click: it connects to the bridge,
   enables full-site control, shares the tab, and starts the session.
   (Chrome asks for a per-site banner grant the first time per site —
   accept it, or the share is refused.)
3. The yellow banner appears and the toolbar badge reads ON. Chrome also
   shows its own "debugging this browser" infobar — expected.
4. Squish drives via `POST /v1/commands` (and can see your open tabs via
   `list_tabs` to suggest which one to share). You watch; sign in yourself
   if a login appears (the agent stops and waits — that is the design, not
   a bug).
5. **STOP** any time: popup button, `Ctrl+Shift+S`, or the banner's STOP.

Full-site control means any `https://` page except denylisted ones (banks,
password managers) is shareable — the Connect button enables the
underlying Open Mode automatically. The per-site banner grant,
banner/badge/STOP, and audit log still apply; Open Mode skips only the
allowlist step. Prefer the classic closed list? Unticking Open Mode in the
popup returns to allowlist-only sharing.

Two more v0.4 behaviors worth knowing:

- **Popups are followed.** When the shared page opens a tab itself (OAuth
  login, `target=_blank` docs), the session moves to it automatically —
  still one tab, still policy-gated, logged as `follow-tab`. A popup that
  fails the gate stays unshared; share it explicitly if you want it driven.
- **Uploads are user-named.** To put a file into a form, name its local path
  in chat (`upload C:\invoices\q3.pdf`) and Squish sets it on the file
  input. The agent cannot browse your disk — only paths you utter.

## Troubleshooting

| Symptom | Cause → fix |
|---|---|
| Pair fails "cannot reach bridge" | Wrong address/port, or bridge not running → `tools/bridge.ps1 status`; start it if down. |
| Agent probes time out / empty reply (curl rc=52) | Server is DOWN (nothing listening) → `tools/bridge.ps1 status`, then `start`. Do not re-pair and do not touch the firewall until the server answers `/health` locally. |
| Popup says `bridge disconnected` while sharing | Socket down, session stale → start the server; the extension reconnects on its own (pairing survives restarts). If it says `Not paired`, ask Squish for a fresh code and re-pair. |
| "port 3031 is busy" on start | A bridge is already running → `tools/bridge.ps1 stop` first, or set `SQUISH_BRIDGE_PORT`. |
| Windows Firewall prompt for Node.js | First tailnet/LAN listen → Allow (private networks at least) or Squish can't dial in. |
| Squish gets 403 from the bridge API | Its IP isn't trusted → it must dial from your tailnet (range `100.64.0.0/10` trusted by default); check `tailscale status`. |
| "pairing refused: code-expired / unknown-or-spent" | Code older than 10 min or already used → ask Squish for a fresh one. |
| Connect (or Add) says "permission denied" for a site | The host-grant prompt was dismissed or blocked → press Connect again and click **Allow** on the Chrome prompt ("read and change data on …"). No prompt appearing at all means the extension is stale → reload it at `chrome://extensions` and retry. |
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
  `GET /v1/audit` (trusted sources only).
