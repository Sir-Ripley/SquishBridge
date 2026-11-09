"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const { createServer } = require("../server");

// Scratch audit log: test files run in parallel processes and must not
// share the real bridge/audit.log.jsonl.
const SCRATCH_LOG = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sb-health-")), "audit.log");
const opts = () => ({ auditLog: SCRATCH_LOG });

function get(port, path) {
  return new Promise((resolve, reject) => {
    const http = require("node:http");
    http
      .get({ host: "127.0.0.1", port, path }, (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
      })
      .on("error", reject);
  });
}

test("GET /health reports ok + version", async () => {
  const server = createServer(opts());
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const { status, body } = await get(server.address().port, "/health");
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.service, "squish-bridge");
    assert.match(body.version, /^\d+\.\d+\.\d+/);
  } finally {
    server.close();
  }
});

test("loopback audit viewer returns entries newest-last, capped", async () => {
  const server = createServer(opts());
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const port = server.address().port;
    await get(port, "/health");
    await get(port, "/nope");
    const res = await fetch(`http://127.0.0.1:${port}/v1/audit?limit=10`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.entries));
    const paths = body.entries.map((e) => e.path);
    assert.ok(paths.includes("/health") && paths.includes("/nope"));
    // The audit endpoint logs its own request, so the newest entry is
    // the audit read itself and the one before it is /nope.
    const capped = await (await fetch(`http://127.0.0.1:${port}/v1/audit?limit=2`)).json();
    assert.equal(capped.entries.length, 2);
    assert.equal(capped.entries[0].path, "/nope");
    assert.equal(capped.entries[1].path, "/v1/audit?limit=10");
  } finally {
    server.close();
  }
});

test("unknown routes 404; commands accept POST only (GET is 405)", async () => {
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const port = server.address().port;
    const notFound = await get(port, "/nope");
    assert.equal(notFound.status, 404);
    assert.equal(notFound.body.error, "not found");
    // Pairing is real in M1 but POST-only: a GET is not a pairing exchange.
    const pairingGet = await get(port, "/v1/pair/code");
    assert.equal(pairingGet.status, 404);
    const commands = await get(port, "/v1/commands");
    assert.equal(commands.status, 405);
    assert.equal(commands.body.error, "method-not-allowed");
  } finally {
    server.close();
  }
});

test("trailing slashes never 404 known routes", async () => {
  const server = createServer(opts());
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const port = server.address().port;
    assert.equal((await get(port, "/health/")).status, 200);
    assert.equal((await get(port, "/v1/status/")).status, 200);
    assert.equal((await get(port, "/v1/devices/")).status, 200);
  } finally {
    server.close();
  }
});

test("status answers on loopback with dial addresses", async () => {
  const server = createServer(opts());
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const port = server.address().port;
    const res = await get(port, "/v1/status");
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.ok(Array.isArray(res.body.addrs), "status still reports dial addresses");
  } finally {
    server.close();
  }
});
