"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { lanAddrs } = require("../server");

test("lanAddrs lists unique non-loopback IPv4 addresses only", () => {
  const addrs = lanAddrs();
  assert.ok(Array.isArray(addrs));
  for (const a of addrs) {
    assert.match(a, /^\d{1,3}(\.\d{1,3}){3}$/, a);
    assert.ok(!a.startsWith("127."), "no loopback: " + a);
  }
  assert.deepEqual([...new Set(addrs)], addrs);
});
