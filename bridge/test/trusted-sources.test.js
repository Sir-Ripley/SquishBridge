"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { isTrusted, isLoopback, TRUSTED_SOURCES } = require("../server");

const reqWith = (remoteAddress) => ({ socket: { remoteAddress } });

test("loopback sources stay trusted", () => {
  assert.equal(isLoopback(reqWith("127.0.0.1")), true);
  assert.equal(isTrusted(reqWith("127.0.0.1")), true);
  assert.equal(isTrusted(reqWith("::1")), true);
  assert.equal(isTrusted(reqWith("::ffff:127.0.0.1")), true);
});

test("agent tailnet IP is trusted, public IP is not", () => {
  assert.ok(TRUSTED_SOURCES.has("100.64.214.38"));
  assert.equal(isTrusted(reqWith("100.64.214.38")), true);
  assert.equal(isTrusted(reqWith("::ffff:100.64.214.38")), true);
  assert.equal(isTrusted(reqWith("8.8.8.8")), false);
  assert.equal(isTrusted(reqWith(null)), false);
  assert.equal(isTrusted({}), false);
});
