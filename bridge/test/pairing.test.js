"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const WebSocket = require("ws");
const pairing = require("../lib/pairing");

// ---- Pure unit tests (no server) ----

test("code redeems once, then reports spent", () => {
  const store = pairing.createPairingStore();
  const { code } = pairing.issueCode(store);
  assert.equal(pairing.redeemCode(store, code).ok, true);
  const again = pairing.redeemCode(store, code);
  assert.equal(again.ok, false);
  assert.equal(again.error, "unknown-or-spent-code");
});

test("expired codes are rejected and pruned", () => {
  const store = pairing.createPairingStore();
  const { code } = pairing.issueCode(store, { ttlMs: 60 * 1000, now: 0 });
  const res = pairing.redeemCode(store, code, { now: 61 * 1000 });
  assert.equal(res.ok, false);
  assert.equal(res.error, "code-expired");
  assert.equal(pairing.pendingCount(store, { now: 61 * 1000 }), 0);
});

test("a bad-shaped exchange burns the code", () => {
  const store = pairing.createPairingStore();
  const { code } = pairing.issueCode(store);
  pairing.failAttempt(store, code);
  assert.equal(pairing.redeemCode(store, code).ok, false);
});

test("device store: register/find/revoke, hashes never match after revoke", () => {
  const devices = {};
  pairing.registerDevice(devices, "laptop-1", "abc123");
  assert.ok(pairing.findDeviceByHash(devices, "abc123"));
  assert.ok(!pairing.findDeviceByHash(devices, "wrong"));
  assert.equal(pairing.revokeDevice(devices, "laptop-1"), true);
  assert.equal(pairing.revokeDevice(devices, "laptop-1"), false);
  assert.equal(pairing.findDeviceByHash(devices, "abc123"), null);
});

// ---- Full HTTP + WebSocket flow against a live server ----

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-test-"));
const tmpFile = path.join(tmpDir, "devices.json");
const { createServer } = require("../server");

let server;
let port;
before(async () => {
  server = createServer({ devicesFile: tmpFile, auditLog: path.join(tmpDir, "audit.log") });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  port = server.address().port;
});
after(() => new Promise((r) => server.close(r)));

async function post(p, body) {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

function nextMessage(ws) {
  return new Promise((resolve) => ws.once("message", (d) => resolve(JSON.parse(String(d)))));
}

test("pairing flow: code -> exchange -> devices -> revoke", async () => {
  const issued = await post("/v1/pair/code", {});
  assert.equal(issued.status, 201);
  assert.match(issued.body.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

  const bad = await post("/v1/pair/exchange", { code: "XXXX-XXXX", installId: "laptop-1" });
  assert.equal(bad.status, 403);

  const exchanged = await post("/v1/pair/exchange", { code: issued.body.code, installId: "laptop-1" });
  assert.equal(exchanged.status, 201);
  assert.equal(typeof exchanged.body.token, "string");
  const token = exchanged.body.token;

  const reused = await post("/v1/pair/exchange", { code: issued.body.code, installId: "laptop-1" });
  assert.equal(reused.status, 403);

  const listed = await (await fetch(`http://127.0.0.1:${port}/v1/devices`)).json();
  assert.equal(listed.ok, true);
  assert.equal(listed.devices.length, 1);
  assert.equal(listed.devices[0].installId, "laptop-1");
  assert.ok(!("tokenHash" in listed.devices[0]), "hash must never leave the bridge");

  // Token hash is what's stored: raw token must not appear on disk.
  const onDisk = fs.readFileSync(tmpFile, "utf8");
  assert.ok(!onDisk.includes(token), "raw token must not be stored");

  // WebSocket authenticates with the issued token.
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/extension`);
  await new Promise((r) => ws.on("open", r));
  ws.send(JSON.stringify({ id: "a1", type: "auth", payload: { token, installId: "laptop-1" } }));
  const hello = await nextMessage(ws);
  assert.equal(hello.id, "a1");
  assert.equal(hello.ok, true);

  ws.send(JSON.stringify({ id: "p1", type: "ping", payload: {} }));
  const pong = await nextMessage(ws);
  assert.deepEqual(pong, { id: "p1", ok: true, result: { pong: true } });

  ws.send(JSON.stringify({ id: "c1", type: "navigate", payload: { url: "https://github.com/" } }));
  const refused = await nextMessage(ws);
  assert.equal(refused.id, "c1");
  assert.equal(refused.ok, false);
  assert.equal(refused.error, "unknown-message-type");

  // Revoke drops the device and closes the socket.
  const closed = new Promise((r) => ws.on("close", (code) => r(code)));
  const revoked = await post("/v1/devices/revoke", { installId: "laptop-1" });
  assert.deepEqual(revoked.body, { ok: true, revoked: true });
  assert.equal(await closed, 4403);

  // The revoked token no longer authenticates.
  const ws2 = new WebSocket(`ws://127.0.0.1:${port}/v1/extension`);
  await new Promise((r) => ws2.on("open", r));
  const closed2 = new Promise((r) => ws2.on("close", (code) => r(code)));
  ws2.send(JSON.stringify({ id: "a2", type: "auth", payload: { token, installId: "laptop-1" } }));
  assert.equal(await closed2, 4401);
});

test("socket pairing: code -> token -> auth on the same socket", async () => {
  const issued = await post("/v1/pair/code", {});
  assert.equal(issued.status, 201);

  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/extension`);
  await new Promise((r) => ws.on("open", r));
  ws.send(JSON.stringify({ id: "p1", type: "pair", payload: { code: issued.body.code, installId: "laptop-2" } }));
  const paired = await nextMessage(ws);
  assert.equal(paired.id, "p1");
  assert.equal(paired.ok, true);
  assert.equal(paired.result.installId, "laptop-2");

  ws.send(JSON.stringify({ id: "a3", type: "auth", payload: { token: paired.result.token, installId: "laptop-2" } }));
  const hello = await nextMessage(ws);
  assert.deepEqual(hello, { id: "a3", ok: true, result: { hello: "squish-bridge", version: require("../package.json").version } });
  ws.close();

  // A bad code over the socket is refused, not fatal to the socket.
  const wsBad = new WebSocket(`ws://127.0.0.1:${port}/v1/extension`);
  await new Promise((r) => wsBad.on("open", r));
  wsBad.send(JSON.stringify({ id: "p2", type: "pair", payload: { code: "NOPE-NOPE", installId: "laptop-3" } }));
  const refused = await nextMessage(wsBad);
  assert.equal(refused.id, "p2");
  assert.equal(refused.ok, false);
  wsBad.close();
});
