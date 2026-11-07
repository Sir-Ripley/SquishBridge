"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { sbAuditEntry, sbAuditAppend, SB_AUDIT_MAX_ENTRIES } = require("../lib/audit");

test("audit entries carry timestamp/command/origin/status; detail capped", () => {
  const e = sbAuditEntry("click", "https://github.com", "ok", "x".repeat(9999));
  assert.ok(Date.parse(e.ts));
  assert.equal(e.command, "click");
  assert.ok(e.detail.length <= 500);
});

test("audit log is a capped ring buffer", () => {
  let log = [];
  for (let i = 0; i < SB_AUDIT_MAX_ENTRIES + 10; i++) {
    log = sbAuditAppend(log, sbAuditEntry("cmd", "", "ok", String(i)));
  }
  assert.equal(log.length, SB_AUDIT_MAX_ENTRIES);
  assert.equal(log[log.length - 1].detail, String(SB_AUDIT_MAX_ENTRIES + 9));
});
