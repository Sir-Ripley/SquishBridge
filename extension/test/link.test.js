"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const link = require("../lib/link");

test("backoff grows exponentially and caps at 60s", () => {
  const d0 = link.sbBackoffDelay(0);
  assert.ok(d0 >= 750 && d0 <= 1250, `attempt 0 out of range: ${d0}`);
  for (let i = 0; i < 10; i++) {
    const d = link.sbBackoffDelay(i);
    assert.ok(d <= 75000, `attempt ${i} too large: ${d}`);
  }
  assert.ok(link.sbBackoffDelay(100) <= 75000);
  assert.ok(link.sbBackoffDelay(100) >= 45000);
});

test("bridge URL normalization accepts host:port, rejects paths and http", () => {
  assert.equal(link.sbNormalizeBridgeUrl("ws://100.64.0.1:3031"), "ws://100.64.0.1:3031");
  assert.equal(link.sbNormalizeBridgeUrl("  wss://example.ts.net:3031/ "), "wss://example.ts.net:3031");
  assert.throws(() => link.sbNormalizeBridgeUrl("http://x:3031"), /ws:\/\//);
  assert.throws(() => link.sbNormalizeBridgeUrl("ws://x:3031/extra/path"), /no path/);
  assert.throws(() => link.sbNormalizeBridgeUrl(""), /bridge address/);
});

test("socket URL derives from the stored bridge URL", () => {
  assert.equal(link.sbSocketUrl("ws://100.64.0.1:3031"), "ws://100.64.0.1:3031/v1/extension");
  assert.equal(link.sbSocketUrl("wss://example.ts.net:3031/"), "wss://example.ts.net:3031/v1/extension");
});

test("auth envelope shape + ok detection", () => {
  const m = link.sbAuthMessage("id-1", "tok", "install-1");
  assert.deepEqual(m, { id: "id-1", type: "auth", payload: { token: "tok", installId: "install-1" } });
  assert.ok(link.sbIsAuthOk({ ok: true, result: {} }));
  assert.ok(!link.sbIsAuthOk({ ok: false, error: "x" }));
});

test("link age label: active seconds/minutes, silent minutes/hours, unknown", () => {
  const now = Date.parse("2026-11-09T17:00:00.000Z");
  const ago = (s) => new Date(now - s * 1000).toISOString();
  assert.equal(link.sbLinkAgeLabel(now, ago(12)), "active 12s ago");
  assert.equal(link.sbLinkAgeLabel(now, ago(89)), "active 89s ago");
  assert.equal(link.sbLinkAgeLabel(now, ago(150)), "active 2m ago");
  assert.equal(link.sbLinkAgeLabel(now, ago(22 * 60)), "silent 22m");
  assert.equal(link.sbLinkAgeLabel(now, ago(3 * 3600)), "silent 3h");
  assert.equal(link.sbLinkAgeLabel(now, null), "unknown");
  assert.equal(link.sbLinkAgeLabel(now, undefined), "unknown");
  assert.equal(link.sbLinkAgeLabel(now, "not-a-date"), "unknown");
  assert.equal(link.sbLinkAgeLabel(now, ago(-30)), "active 0s ago"); // clock skew clamps
});
