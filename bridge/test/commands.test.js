"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const WebSocket = require("ws");
const { createRouter } = require("../lib/router");

test("router matches results to sends by id", async () => {
  const sent = [];
  const r = createRouter({ send: (m) => sent.push(m), defaultTimeoutMs: 5000 });
  const p = r.sendCommand("get_state", {}, { id: "x1" });
  assert.deepEqual(sent[0], { id: "x1", type: "get_state", payload: {} });
  assert.equal(r.pendingCount(), 1);
  assert.equal(r.handleResult({ id: "nope", ok: true, result: {} }), false);
  assert.equal(r.handleResult({ noId: true }), false);
  assert.equal(r.handleResult({ id: "x1", ok: true, result: { url: "https://github.com/" } }), true);
  assert.deepEqual(await p, { id: "x1", ok: true, result: { url: "https://github.com/" } });
  assert.equal(r.pendingCount(), 0);
});

test("router times out and fails all pending on death", async () => {
  const r = createRouter({ send: () => {}, defaultTimeoutMs: 50 });
  await assert.rejects(r.sendCommand("screenshot", {}, { id: "t1", timeoutMs: 50 }), /timed out/);
  const r2 = createRouter({ send: () => {}, defaultTimeoutMs: 5000 });
  const p = r2.sendCommand("screenshot", {}, { id: "t2" });
  r2.failAll(new Error("extension disconnected"));
  await assert.rejects(p, /extension disconnected/);
});

// ---- HTTP command API against a live server with a fake extension ----

const tmpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sb-cmd-")), "devices.json");
const { createServer } = require("../server");

let server;
let port;
before(async () => {
  server = createServer({ devicesFile: tmpFile });
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

// Pair + auth a fake extension; handle commands per the given handler.
async function fakeExtension(installId, onCommand) {
  const code = (await (await fetch(`http://127.0.0.1:${port}/v1/pair/code`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).json()).code;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/extension`);
  await new Promise((r) => ws.on("open", r));
  const next = () => new Promise((r) => ws.once("message", (d) => r(JSON.parse(String(d)))));
  ws.send(JSON.stringify({ id: "p", type: "pair", payload: { code, installId } }));
  const paired = await next();
  assert.equal(paired.ok, true);
  ws.send(JSON.stringify({ id: "a", type: "auth", payload: { token: paired.result.token, installId } }));
  assert.equal((await next()).ok, true);
  ws.on("message", (data) => {
    let msg = null;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (msg && msg.type && msg.id) onCommand(ws, msg);
  });
  return ws;
}

test("command round trip: Squish -> bridge -> extension -> result", async () => {
  const ws = await fakeExtension("cmd-ext-1", (sock, msg) => {
    sock.send(JSON.stringify({ id: msg.id, ok: true, result: { url: "https://github.com/", title: "GitHub" } }));
  });
  try {
    const res = await post("/v1/commands", { type: "get_state", payload: {} });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.result.url, "https://github.com/");
  } finally {
    ws.close();
  }
});

test("extension refusal passes through as 502", async () => {
  const ws = await fakeExtension("cmd-ext-2", (sock, msg) => {
    sock.send(JSON.stringify({ id: msg.id, ok: false, error: "refused: origin not allowlisted" }));
  });
  try {
    const res = await post("/v1/commands", { type: "navigate", payload: { url: "https://evil.com/" } });
    assert.equal(res.status, 502);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.error, "refused: origin not allowlisted");
  } finally {
    ws.close();
  }
});

test("no device connected -> 409; silent extension -> 408 timeout", async () => {
  const none = await post("/v1/commands", { installId: "ghost", type: "get_state" });
  assert.equal(none.status, 409);
  assert.equal(none.body.error, "device-not-connected");

  const ws = await fakeExtension("cmd-ext-3", () => { /* never answers */ });
  try {
    const res = await post("/v1/commands", { type: "screenshot", payload: {}, timeoutMs: 1000 });
    assert.equal(res.status, 408);
    assert.equal(res.body.error, "command-timeout");
  } finally {
    ws.close();
  }
});
