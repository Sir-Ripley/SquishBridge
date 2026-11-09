"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { isTrusted, isLoopback, isTailnetAddr, tailnetTrustEnabled, resolveHost, TRUSTED_SOURCES } = require("../server");

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

test("tailnet range 100.64.0.0/10 is trusted by default, neighbors are not", () => {
  for (const a of ["100.64.0.1", "100.64.214.38", "100.100.1.2", "100.127.255.254"]) {
    assert.equal(isTailnetAddr(a), true, a);
    assert.equal(isTrusted(reqWith(a)), true, a);
  }
  for (const a of ["100.63.255.255", "100.128.0.1", "99.64.0.1", "101.64.0.1", "8.8.8.8", "192.168.1.2", "not-an-ip", ""]) {
    assert.equal(isTailnetAddr(a), false, a);
  }
  assert.equal(isTrusted(reqWith("100.100.1.2")), true);
  assert.equal(isTrusted(reqWith("192.168.1.2")), false);
});

test("SQUISH_BRIDGE_TRUST_TAILNET=0 disables range trust, explicit IPs stay", () => {
  const prev = process.env.SQUISH_BRIDGE_TRUST_TAILNET;
  try {
    assert.equal(tailnetTrustEnabled(), true);
    process.env.SQUISH_BRIDGE_TRUST_TAILNET = "0";
    assert.equal(tailnetTrustEnabled(), false);
    assert.equal(isTrusted(reqWith("100.100.1.2")), false);
    assert.equal(isTrusted(reqWith("100.64.214.38")), true); // explicit entry survives
    assert.equal(isTrusted(reqWith("127.0.0.1")), true);
  } finally {
    if (prev === undefined) delete process.env.SQUISH_BRIDGE_TRUST_TAILNET;
    else process.env.SQUISH_BRIDGE_TRUST_TAILNET = prev;
  }
});

test("resolveHost defaults to all interfaces, honors override", () => {
  const prev = process.env.SQUISH_BRIDGE_HOST;
  try {
    delete process.env.SQUISH_BRIDGE_HOST;
    assert.equal(resolveHost(), "0.0.0.0");
    process.env.SQUISH_BRIDGE_HOST = "127.0.0.1";
    assert.equal(resolveHost(), "127.0.0.1");
    process.env.SQUISH_BRIDGE_HOST = "  100.87.226.76  ";
    assert.equal(resolveHost(), "100.87.226.76");
  } finally {
    if (prev === undefined) delete process.env.SQUISH_BRIDGE_HOST;
    else process.env.SQUISH_BRIDGE_HOST = prev;
  }
});
