"use strict";

/* Squish Bridge — bridge server (M0 scaffold).
 * Stdlib-only Node http server, loopback-bound by default.
 *
 * Real in M0: GET /health, JSON routing + audit log of every request,
 * loopback-only binding, graceful 501 stubs marking M1/M2 work.
 * M1 adds: pairing exchange + token store (see lib/tokens.js) + the
 * extension WebSocket endpoint. M2 adds: the local command API bodies.
 */

const http = require("node:http");
const audit = require("./lib/audit");

const VERSION = require("./package.json").version;
const HOST = process.env.SQUISH_BRIDGE_HOST || "127.0.0.1";
const PORT = Number(process.env.SQUISH_BRIDGE_PORT) || 3031;
const LOG_FILE = process.env.SQUISH_BRIDGE_AUDIT_LOG || audit.DEFAULT_LOG_FILE;

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

function createServer() {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://localhost");
      const origin = req.headers.origin || "";

      if (req.method === "GET" && url.pathname === "/health") {
        return sendJson(res, req, 200, { ok: true, service: "squish-bridge", version: VERSION }, origin);
      }

      if (req.method === "GET" && url.pathname === "/v1/status") {
        return sendJson(
          res,
          req,
          200,
          { ok: true, version: VERSION, pairing: "M1", commands: "M2", sessions: "none" },
          origin
        );
      }

      if (url.pathname.startsWith("/v1/pair")) {
        await readBody(req).catch(() => {});
        return notImplemented(res, req, "M1-pairing", "pairing");
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

  // No WebSocket library in M0: answer upgrade attempts with 501 and close.
  server.on("upgrade", (req, socket) => {
    audit.append(LOG_FILE, audit.entry("WS", req.url || "/", 501, "", "M1-pairing"));
    try {
      socket.write("HTTP/1.1 501 Not Implemented\r\nConnection: close\r\n\r\n");
    } finally {
      socket.destroy();
    }
  });

  return server;
}

if (require.main === module) {
  const server = createServer();
  server.listen(PORT, HOST, () => {
    console.log(`squish-bridge v${VERSION} listening on http://${HOST}:${PORT} (loopback-only by default)`);
  });
}

module.exports = { createServer, VERSION };
