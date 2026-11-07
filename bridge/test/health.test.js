"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createServer } = require("../server");

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
  const server = createServer();
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

test("unknown routes 404, pairing/commands 501 until their milestone", async () => {
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const port = server.address().port;
    const notFound = await get(port, "/nope");
    assert.equal(notFound.status, 404);
    const pairing = await get(port, "/v1/pair/code");
    assert.equal(pairing.status, 501);
    const commands = await get(port, "/v1/commands");
    assert.equal(commands.status, 501);
  } finally {
    server.close();
  }
});
