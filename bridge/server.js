"use strict";

/* Squish Bridge — bridge server (M1).
 * Stdlib http + `ws` for the extension socket. Loopback-bound by default;
 * on the agent machine set SQUISH_BRIDGE_HOST to the tailnet IP so the
 * extension can reach it without touching the public internet.
 *
 * Real in M1: pairing code issue/exchange, device token store (hash at
 * rest), revoke/unpair, authenticated extension WebSocket with reconnect
 * support, heartbeat, per-request audit log.
 * M2 adds: the local command API bodies and socket command routing.
 */

const http = require("node:http");
const path = require("node:path");
const { WebSocketServer } = require("ws");
const audit = require("./lib/audit");
const tokens = require("./lib/tokens");
const pairing = require("./lib/pairing");
const { createRouter } = require("./lib/router");

const VERSION = require("./package.json").version;
const HOST = process.env.SQUISH_BRIDGE_HOST || "127.0.0.1";
const PORT = Number(process.env.SQUISH_BRIDGE_PORT) || 3031;
// Mutable so tests can point a server at a scratch log; production runs one
// server per process, so this is never shared.
let LOG_FILE = process.env.SQUISH_BRIDGE_AUDIT_LOG || audit.DEFAULT_LOG_FILE;
const DEVICES_FILE =
  process.env.SQUISH_BRIDGE_DEVICES_FILE ||
  path.join(__dirname, "devices.json");

const AUTH_TIMEOUT_MS = 10 * 1000;
const HEARTBEAT_MS = 25 * 1000;

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

function isLoopback(req) {
  return LOOPBACK.has(req.socket && req.socket.remoteAddress);
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

function notImplemented(res, req, milestone, what) {
  return sendJson(res, req, 501, { ok: false, error: `${what} arrives in ${milestone}` });
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

      if (req.method === "GET" && url.pathname === "/health") {
        return sendJson(res, req, 200, { ok: true, service: "squish-bridge", version: VERSION }, origin);
      }

      if (req.method === "GET" && url.pathname === "/v1/status") {
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
          },
          origin
        );
      }

      // Squish-only: mint a one-time pairing code (shown in chat).
      if (req.method === "POST" && url.pathname === "/v1/pair/code") {
        if (!isLoopback(req)) return sendJson(res, req, 403, { ok: false, error: "loopback-only" }, origin);
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

      // Squish-only: inspect devices (hashes never leave the bridge).
      if (req.method === "GET" && url.pathname === "/v1/devices") {
        if (!isLoopback(req)) return sendJson(res, req, 403, { ok: false, error: "loopback-only" }, origin);
        const list = Object.entries(devices).map(([installId, d]) => ({
          installId,
          createdAt: d.createdAt,
          revokedAt: d.revokedAt,
          lastSeenAt: d.lastSeenAt,
        }));
        return sendJson(res, req, 200, { ok: true, devices: list }, origin);
      }

      // Squish-only: inspect the bridge audit log (page content is never
      // logged, so entries are safe to read back into chat).
      if (req.method === "GET" && url.pathname === "/v1/audit") {
        if (!isLoopback(req)) return sendJson(res, req, 403, { ok: false, error: "loopback-only" }, origin);
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 100, 1), 500);
        return sendJson(res, req, 200, { ok: true, entries: audit.readTail(LOG_FILE, limit) }, origin);
      }

      // Squish-only: submit a command to a paired browser. The bridge
      // forwards it over the extension socket and awaits the result —
      // the HTTP response IS the command result (M2 eyes).
      if (req.method === "POST" && url.pathname === "/v1/commands") {
        if (!isLoopback(req)) return sendJson(res, req, 403, { ok: false, error: "loopback-only" }, origin);
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

      // Squish-only (or extension unpair via its own token — M1: loopback
      // only; the popup unpairs locally and the socket close is observed).
      if (req.method === "POST" && url.pathname === "/v1/devices/revoke") {
        if (!isLoopback(req)) return sendJson(res, req, 403, { ok: false, error: "loopback-only" }, origin);
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

      if (url.pathname === "/v1/commands" || url.pathname.startsWith("/v1/commands/")) {
        await readBody(req).catch(() => {});
        return notImplemented(res, req, "M2-eyes", "command API");
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
      ws.on("pong", function mark() {
        ws._sbAlive = true;
      }, { once: true });
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
  const server = createServer();
  server.listen(PORT, HOST, () => {
    console.log(`squish-bridge v${VERSION} listening on http://${HOST}:${PORT} (pairing ready)`);
  });
}

module.exports = { createServer, VERSION };
