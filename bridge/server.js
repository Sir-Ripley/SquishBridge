"use strict";

/* Squish Bridge — bridge server.
 * Stdlib http + `ws` for the extension socket. Runs on the laptop: binds
 * all interfaces by default (loopback for the extension, tailnet/LAN for
 * the agent) with the admin API gated to trusted sources — reachability
 * is not access. Pairing code issue/exchange, device token store (hash at
 * rest), revoke/unpair, authenticated extension WebSocket with reconnect
 * support, heartbeat, per-request audit log, and the command API whose
 * HTTP responses ARE the command results.
 */

const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { WebSocketServer } = require("ws");
const audit = require("./lib/audit");
const tokens = require("./lib/tokens");
const pairing = require("./lib/pairing");
const bridgeConfig = require("./lib/config");
const { createRouter } = require("./lib/router");

const VERSION = require("./package.json").version;
// Bind everywhere by default: the extension pairs over loopback while the
// agent dials in over the tailnet, and one default must serve both. The
// admin API stays gated by isTrusted below, so reachability is not access.
// Lock down with SQUISH_BRIDGE_HOST=127.0.0.1 when the agent needs no entry.
//
// v0.6: the boot path (require.main) resolves host/port/trust from
// bridge.config.json with env overrides (see lib/config.js) and assigns the
// lets below. The library path (require, used by tests) keeps the plain
// env-or-default behavior so it never touches the file.
function resolveHost() {
  const h = (process.env.SQUISH_BRIDGE_HOST || "").trim();
  return h || "0.0.0.0";
}
let HOST = resolveHost();
let PORT = Number(process.env.SQUISH_BRIDGE_PORT) || 3031;
let TRUST_TAILNET_OVERRIDE = null; // set by the boot path when the config file rules
// Mutable so tests can point a server at a scratch log; production runs one
// server per process, so this is never shared.
let LOG_FILE = process.env.SQUISH_BRIDGE_AUDIT_LOG || audit.DEFAULT_LOG_FILE;
const DEVICES_FILE =
  process.env.SQUISH_BRIDGE_DEVICES_FILE ||
  path.join(__dirname, "devices.json");

const AUTH_TIMEOUT_MS = 10 * 1000;
const HEARTBEAT_MS = 25 * 1000;

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

// Extra loopback-exempt source(s): explicit tailnet IPs, so Squish can mint
// codes and drive commands over the tailnet while the public internet stays
// refused. Comma-separated override: SQUISH_BRIDGE_TRUSTED_IPS="100.x.y.z".
// On top of that, the whole tailnet range 100.64.0.0/10 is trusted by
// default — on this machine only Tailscale uses that range, tailnet
// membership is the real boundary, and agent IPs rotate. Disable with
// SQUISH_BRIDGE_TRUST_TAILNET=0 to fall back to explicit IPs only.
const TRUSTED_SOURCES = new Set(
  (process.env.SQUISH_BRIDGE_TRUSTED_IPS || "100.64.214.38")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

function normalizeAddr(addr) {
  if (!addr) return "";
  if (addr.startsWith("::ffff:")) return addr.slice(7);
  return addr;
}

function tailnetTrustEnabled() {
  if (TRUST_TAILNET_OVERRIDE !== null) return TRUST_TAILNET_OVERRIDE;
  const v = (process.env.SQUISH_BRIDGE_TRUST_TAILNET || "").trim().toLowerCase();
  return v !== "0" && v !== "false" && v !== "no";
}

// Boot-path only: apply the resolved file+env config to the module lets.
function applyResolvedConfig(resolved) {
  HOST = resolved.host;
  PORT = resolved.port;
  // Mutate in place: TRUSTED_SOURCES is a live export, so reassignment
  // would leave require() holders looking at the stale set.
  TRUSTED_SOURCES.clear();
  for (const ip of resolved.trustedIps) TRUSTED_SOURCES.add(ip);
  TRUST_TAILNET_OVERRIDE = resolved.trustTailnet;
}

function isTailnetAddr(addr) {
  const parts = normalizeAddr(addr || "").split(".");
  if (parts.length !== 4) return false;
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : -1));
  if (nums.some((n) => n < 0 || n > 255)) return false;
  return nums[0] === 100 && nums[1] >= 64 && nums[1] <= 127;
}

function isLoopback(req) {
  return LOOPBACK.has(req.socket && req.socket.remoteAddress);
}

function isTrusted(req) {
  const addr = req.socket && req.socket.remoteAddress;
  if (!addr) return false;
  if (LOOPBACK.has(addr)) return true;
  const peer = normalizeAddr(addr);
  if (TRUSTED_SOURCES.has(peer)) return true;
  return tailnetTrustEnabled() && isTailnetAddr(peer);
}

// Non-loopback IPv4 addresses (tailnet, LAN) so the operator can see at a
// glance where the agent should dial. Loopback is always there; this lists
// the rest.
function lanAddrs() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni && ni.family === "IPv4" && !ni.internal && ni.address) out.push(ni.address);
    }
  }
  return [...new Set(out)];
}

function sendJson(res, req, status, body, origin) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
  audit.append(LOG_FILE, audit.entry(req.method, req.url, status, origin || "", ""));
  return undefined;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        req.destroy();
        reject(new Error("body too large"));
      }
    });
    req.on("end", () => resolve(raw));
    req.on("error", reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  return JSON.parse(raw);
}

function createServer({ devicesFile = DEVICES_FILE, auditLog = null } = {}) {
  if (auditLog) LOG_FILE = auditLog;
  const store = pairing.createPairingStore();
  const devices = pairing.loadDevices(devicesFile);
  const sockets = new Map(); // installId -> ws
  const routers = new Map(); // installId -> router
  // v0.6 P0 #3, second light: when did a trusted agent last reach us?
  // Stamped on every trusted pair-code mint and command submission (any
  // outcome — even a 4xx proves reachability). Served to trusted HTTP
  // (/v1/status) and to the authed extension (WS "status"); deliberately
  // NOT on public /health, which leaks no activity timing.
  let lastCommandAt = null;
  const touchAgent = () => {
    lastCommandAt = new Date().toISOString();
  };

  function routerFor(installId) {
    let r = routers.get(installId);
    if (!r) {
      const ws = sockets.get(installId);
      if (!ws) return null;
      r = createRouter({
        send: (message) => ws.send(JSON.stringify(message)),
      });
      routers.set(installId, r);
    }
    return r;
  }

  function dropRouter(installId, err) {
    const r = routers.get(installId);
    routers.delete(installId);
    if (r && err) {
      try {
        r.failAll(err);
      } catch {
        /* ignore */
      }
    }
  }

  function persist() {
    pairing.saveDevices(devicesFile, devices);
  }

  function closeSocket(installId, code, reason) {
    dropRouter(installId, new Error("socket closed: " + reason));
    const ws = sockets.get(installId);
    if (ws) {
      sockets.delete(installId);
      try {
        ws.close(code, reason);
      } catch {
        /* already gone */
      }
    }
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://localhost");
      const origin = req.headers.origin || "";
      // Trailing slashes never 404 a known route (/health/ === /health).
      const pathname = url.pathname.replace(/\/+$/, "") || "/";

      if (req.method === "GET" && pathname === "/health") {
        return sendJson(res, req, 200, { ok: true, service: "squish-bridge", version: VERSION }, origin);
      }

      if (req.method === "GET" && pathname === "/v1/status") {
        if (!isTrusted(req)) return sendJson(res, req, 403, { ok: false, error: "untrusted-source" }, origin);
        const live = [...sockets.keys()];
        return sendJson(
          res,
          req,
          200,
          {
            ok: true,
            version: VERSION,
            pairing: "ready",
            commands: "ready",
            devices: Object.keys(devices).length,
            connected: live,
            pendingCodes: pairing.pendingCount(store),
            pendingCommands: [...routers.values()].reduce((n, r) => n + r.pendingCount(), 0),
            addrs: lanAddrs(),
            last_command_at: lastCommandAt,
          },
          origin
        );
      }

      // Trusted-only: mint a one-time pairing code (shown in chat).
      if (req.method === "POST" && pathname === "/v1/pair/code") {
        if (!isTrusted(req)) return sendJson(res, req, 403, { ok: false, error: "untrusted-source" }, origin);
        touchAgent();
        const body = await readJson(req).catch(() => null);
        if (body === null) return sendJson(res, req, 400, { ok: false, error: "bad-json" }, origin);
        const ttlMs = body.ttlMinutes === undefined ? undefined : Number(body.ttlMinutes) * 60 * 1000;
        const { code, expiresAt } = pairing.issueCode(store, ttlMs === undefined ? {} : { ttlMs });
        audit.append(LOG_FILE, audit.entry("PAIR", "/v1/pair/code", 201, "", "code issued"));
        return sendJson(res, req, 201, { ok: true, code, expiresAt }, origin);
      }

      // No HTTP exchange endpoint by design: the code→token trade happens
      // over the socket (see the "pair" message below), so the extension
      // never needs a host permission for the bridge address. One audited
      // path, not two.

      // Trusted-only: inspect devices (hashes never leave the bridge).
      if (req.method === "GET" && pathname === "/v1/devices") {
        if (!isTrusted(req)) return sendJson(res, req, 403, { ok: false, error: "untrusted-source" }, origin);
        const list = Object.entries(devices).map(([installId, d]) => ({
          installId,
          createdAt: d.createdAt,
          revokedAt: d.revokedAt,
          lastSeenAt: d.lastSeenAt,
        }));
        return sendJson(res, req, 200, { ok: true, devices: list }, origin);
      }

      // Trusted-only: inspect the bridge audit log (page content is never
      // logged, so entries are safe to read back into chat).
      if (req.method === "GET" && pathname === "/v1/audit") {
        if (!isTrusted(req)) return sendJson(res, req, 403, { ok: false, error: "untrusted-source" }, origin);
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 100, 1), 500);
        return sendJson(res, req, 200, { ok: true, entries: audit.readTail(LOG_FILE, limit) }, origin);
      }

      // Trusted-only: submit a command to a paired browser. The bridge
      // forwards it over the extension socket and awaits the result —
      // the HTTP response IS the command result.
      if (req.method === "POST" && pathname === "/v1/commands") {
        if (!isTrusted(req)) return sendJson(res, req, 403, { ok: false, error: "untrusted-source" }, origin);
        touchAgent();
        const body = await readJson(req).catch(() => null);
        if (body === null) return sendJson(res, req, 400, { ok: false, error: "bad-json" }, origin);
        if (!body || typeof body.type !== "string" || !body.type) {
          return sendJson(res, req, 400, { ok: false, error: "command type required" }, origin);
        }
        const installId =
          body.installId === undefined ? [...sockets.keys()][0] || null : String(body.installId);
        if (body.installId !== undefined && !sockets.has(installId)) {
          audit.append(LOG_FILE, audit.entry("CMD", `/v1/commands ${body.type}`, 409, "", "no such device"));
          return sendJson(res, req, 409, { ok: false, error: "device-not-connected" }, origin);
        }
        const router = installId ? routerFor(installId) : null;
        if (!router) {
          audit.append(LOG_FILE, audit.entry("CMD", `/v1/commands ${body.type}`, 409, "", "no device connected"));
          return sendJson(res, req, 409, { ok: false, error: "no-device-connected" }, origin);
        }
        if (body.installId === undefined && sockets.size > 1) {
          return sendJson(res, req, 409, { ok: false, error: "ambiguous-device" }, origin);
        }
        try {
          const result = await router.sendCommand(body.type, body.payload || {}, {
            timeoutMs: body.timeoutMs,
          });
          audit.append(
            LOG_FILE,
            audit.entry("CMD", `/v1/commands ${body.type}`, result.ok ? 200 : 502, "", installId)
          );
          return sendJson(res, req, result.ok ? 200 : 502, result, origin);
        } catch (err) {
          const status = err && err.code === "timeout" ? 408 : 502;
          audit.append(LOG_FILE, audit.entry("CMD", `/v1/commands ${body.type}`, status, "", installId));
          return sendJson(
            res,
            req,
            status,
            { ok: false, error: err && err.code === "timeout" ? "command-timeout" : String((err && err.message) || err) },
            origin
          );
        }
      }

      // Trusted-only revoke (the popup unpairs locally and the socket
      // close is observed; this ends it bridge-side too).
      if (req.method === "POST" && pathname === "/v1/devices/revoke") {
        if (!isTrusted(req)) return sendJson(res, req, 403, { ok: false, error: "untrusted-source" }, origin);
        const body = await readJson(req).catch(() => null);
        if (body === null) return sendJson(res, req, 400, { ok: false, error: "bad-json" }, origin);
        const revoked = pairing.revokeDevice(devices, String(body.installId || ""));
        if (revoked) {
          persist();
          closeSocket(String(body.installId), 4403, "device revoked");
          audit.append(LOG_FILE, audit.entry("PAIR", "/v1/devices/revoke", 200, "", String(body.installId)));
        }
        return sendJson(res, req, 200, { ok: true, revoked }, origin);
      }

      if (pathname === "/v1/commands" || pathname.startsWith("/v1/commands/")) {
        await readBody(req).catch(() => {});
        return sendJson(res, req, 405, { ok: false, error: "method-not-allowed" }, origin);
      }

      await readBody(req).catch(() => {});
      return sendJson(res, req, 404, { ok: false, error: "not found" }, origin);
    } catch (err) {
      try {
        return sendJson(res, req, 500, { ok: false, error: String((err && err.message) || err) }, "");
      } catch {
        return undefined;
      }
    }
  });

  // ---- Extension WebSocket (authenticated, M2 routes commands) ----

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    let pathname = "";
    try {
      pathname = new URL(req.url || "/", "http://localhost").pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname !== "/v1/extension") {
      audit.append(LOG_FILE, audit.entry("WS", req.url || "/", 404, "", ""));
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      let authed = null; // { installId }

      const authTimer = setTimeout(() => {
        if (!authed) {
          audit.append(LOG_FILE, audit.entry("WS", "/v1/extension", 4408, "", "auth timeout"));
          try {
            ws.close(4408, "auth timeout");
          } catch {
            /* ignore */
          }
        }
      }, AUTH_TIMEOUT_MS);
      // Don't hold the process open for a half-open socket.
      if (typeof authTimer.unref === "function") authTimer.unref();

      ws.on("message", (data) => {
        let msg = null;
        try {
          msg = JSON.parse(String(data));
        } catch {
          return; // malformed frames are ignored, never crash the bridge
        }
        if (!authed) {
          // Pairing over the socket: trade a one-time code for a device
          // token. Runs here (not over HTTP fetch) so the extension needs
          // no host permission for the bridge address.
          if (msg && msg.type === "pair" && msg.payload && typeof msg.id === "string") {
            const { code, installId } = msg.payload;
            if (!pairing.validInstallId(installId)) {
              pairing.failAttempt(store, code);
              audit.append(LOG_FILE, audit.entry("WS", "/v1/extension pair", 400, "", "bad installId"));
              ws.send(JSON.stringify({ id: msg.id, ok: false, error: "bad-install-id" }));
              return;
            }
            const redemption = pairing.redeemCode(store, code);
            if (!redemption.ok) {
              audit.append(LOG_FILE, audit.entry("WS", "/v1/extension pair", 403, "", redemption.error));
              ws.send(JSON.stringify({ id: msg.id, ok: false, error: redemption.error }));
              return;
            }
            const token = tokens.issueToken();
            pairing.registerDevice(devices, installId, tokens.hashToken(token));
            persist();
            audit.append(LOG_FILE, audit.entry("WS", "/v1/extension pair", 201, "", "device paired"));
            ws.send(JSON.stringify({ id: msg.id, ok: true, result: { token, installId } }));
            return;
          }
          if (msg && msg.type === "auth" && msg.payload) {
            const { token, installId } = msg.payload;
            const found =
              typeof token === "string" &&
              pairing.findDeviceByHash(devices, tokens.hashToken(token));
            if (found && found.installId === installId) {
              authed = { installId };
              const prev = sockets.get(installId);
              if (prev && prev !== ws) {
                try {
                  prev.close(4409, "replaced by new connection");
                } catch {
                  /* ignore */
                }
              }
              sockets.set(installId, ws);
              pairing.touchDevice(devices, installId);
              persist();
              clearTimeout(authTimer);
              audit.append(LOG_FILE, audit.entry("WS", "/v1/extension", 200, "", "connected"));
              ws.send(JSON.stringify({ id: msg.id || null, ok: true, result: { hello: "squish-bridge", version: VERSION } }));
            } else {
              audit.append(LOG_FILE, audit.entry("WS", "/v1/extension", 4401, "", "bad token"));
              try {
                ws.close(4401, "unauthorized");
              } catch {
                /* ignore */
              }
            }
          }
          return;
        }
        // Authenticated traffic: command results (no type) complete the
        // pending loopback request; ping is answered; anything else is
        // logged and ignored.
        if (!msg || typeof msg.id !== "string") return;
        if (!msg.type) {
          const router = routers.get(authed.installId);
          if (router) router.handleResult(msg);
          return;
        }
        if (msg.type === "ping") {
          ws.send(JSON.stringify({ id: msg.id, ok: true, result: { pong: true } }));
          return;
        }
        // v0.6 P0 #3: the paired extension asks (over its authed socket, so
        // no host permission is needed) when the agent last reached us; the
        // popup renders it as the second light ("Squish link: active 12s
        // ago"). Authed-only: pre-auth callers get the same silent ignore
        // as any other non-pair/auth message, so LAN scanners learn nothing.
        if (msg.type === "status") {
          const router = routers.get(authed.installId);
          ws.send(
            JSON.stringify({
              id: msg.id,
              ok: true,
              result: {
                version: VERSION,
                now: new Date().toISOString(),
                last_command_at: lastCommandAt,
                pending_commands: router ? router.pendingCount() : 0,
              },
            })
          );
          return;
        }
        audit.append(
          LOG_FILE,
          audit.entry("WS", `/v1/extension ${msg.type || "?"}`, 501, "", authed.installId)
        );
        ws.send(JSON.stringify({ id: msg.id, ok: false, error: "unknown-message-type" }));
      });

      ws.on("close", () => {
        clearTimeout(authTimer);
        if (authed && sockets.get(authed.installId) === ws) sockets.delete(authed.installId);
        if (authed) dropRouter(authed.installId, new Error("extension disconnected"));
        audit.append(LOG_FILE, audit.entry("WS", "/v1/extension", 0, "", "disconnected"));
      });
    });
  });

  const heartbeat = setInterval(() => {
    for (const [installId, ws] of [...sockets.entries()]) {
      if (ws._sbAlive === false) {
        sockets.delete(installId);
        try {
          ws.terminate();
        } catch {
          /* ignore */
        }
        continue;
      }
      ws._sbAlive = false;
      // once(), not on(): a permanent listener per beat would leak and trip
      // MaxListenersExceededWarning within minutes.
      ws.once("pong", function mark() {
        ws._sbAlive = true;
      });
      try {
        ws.ping();
      } catch {
        /* dead socket; next beat reaps it */
      }
    }
  }, HEARTBEAT_MS);
  if (typeof heartbeat.unref === "function") heartbeat.unref();

  server.on("close", () => clearInterval(heartbeat));

  return server;
}

if (require.main === module) {
  // v0.6 P0 #2: persisted config. First boot writes bridge.config.json with
  // defaults; every boot resolves env > file > defaults, so a plain restart
  // binds exactly like the last run with zero env vars.
  const ensured = bridgeConfig.ensureConfigFile();
  if (ensured.error) {
    console.error(`WARNING: ${ensured.error} — falling back to defaults.`);
  } else if (ensured.created) {
    console.log(`config: created ${bridgeConfig.DEFAULT_CONFIG_FILE} with defaults (edit host/port/trust there).`);
  }
  const resolved = bridgeConfig.resolveConfig({ fileData: ensured.data });
  applyResolvedConfig(resolved);
  const server = createServer();
  server.on("error", (err) => {
    if (err && err.code === "EADDRINUSE") {
      console.error(
        `port ${PORT} is busy — another bridge is already running. Stop it first (tools/bridge.ps1 stop) or pick another port with SQUISH_BRIDGE_PORT.`
      );
      process.exit(1);
    }
    console.error(`bridge failed to listen on ${HOST}:${PORT}: ${(err && err.message) || err}`);
    process.exit(1);
  });
  server.listen(PORT, HOST, () => {
    const scope = HOST === "0.0.0.0" ? "all interfaces (loopback + tailnet/LAN)" : HOST;
    console.log(`squish-bridge v${VERSION} listening on port ${PORT} via ${scope} (pairing ready)`);
    const addrs = lanAddrs();
    console.log(`extension pairs at: ws://127.0.0.1:${PORT}`);
    if (addrs.length) {
      console.log(`agent dials at: ${addrs.map((a) => `ws://${a}:${PORT}`).join(", ")}`);
    }
    const trust = ["loopback"];
    if (tailnetTrustEnabled()) trust.push("tailnet range 100.64.0.0/10");
    for (const ip of TRUSTED_SOURCES) trust.push(ip);
    console.log(`admin API trusts: ${trust.join(" + ")}`);
    console.log(`config: host/port/trust from ${ensured.created ? "fresh defaults" : "bridge.config.json"} (env overrides apply)`);
    // v0.6 P0 #2: verify the bind against the real interfaces. A silent
    // loopback-only bind cost 30+ minutes on 2026-11-09 — never again.
    for (const w of bridgeConfig.verifyBind(HOST, addrs, addrs.filter(isTailnetAddr))) {
      console.log(`WARNING: ${w}`);
    }
  });
}

module.exports = {
  createServer,
  VERSION,
  isTrusted,
  isLoopback,
  isTailnetAddr,
  tailnetTrustEnabled,
  resolveHost,
  TRUSTED_SOURCES,
  lanAddrs,
};
