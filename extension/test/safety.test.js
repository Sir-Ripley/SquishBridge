"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const safety = require("../lib/safety");

test("initial allowlist covers the v0 mission origins", () => {
  for (const h of ["github.com", "gist.github.com", "kaggle.com", "notebooklm.google.com"]) {
    assert.ok(safety.sbIsAllowlisted(h, safety.SB_INITIAL_ALLOWLIST), h);
  }
});

test("subdomain matching is suffix-based, not substring-based", () => {
  assert.ok(safety.sbIsAllowlisted("https://gist.github.com/x", safety.SB_INITIAL_ALLOWLIST));
  assert.ok(!safety.sbIsAllowlisted("https://github.com.evil.com/", safety.SB_INITIAL_ALLOWLIST));
  assert.ok(!safety.sbIsAllowlisted("https://evilgithub.com/", safety.SB_INITIAL_ALLOWLIST));
});

test("denylist wins: banks, password managers, local pages refused", () => {
  assert.ok(safety.sbIsDenied("https://chase.com/login"));
  assert.ok(safety.sbIsDenied("https://my.bank/login"));
  assert.ok(safety.sbIsDenied("https://bitwarden.com/vault"));
  assert.ok(!safety.sbIsDenied("https://github.com/octocat"));
});

test("sbCheckUrl enforces https + denylist + allowlist, in that order", () => {
  assert.deepEqual(safety.sbCheckUrl("http://github.com/", safety.SB_INITIAL_ALLOWLIST), {
    ok: false,
    reason: "origin must be https",
  });
  assert.equal(safety.sbCheckUrl("https://github.com/", safety.SB_INITIAL_ALLOWLIST).ok, true);
  assert.equal(safety.sbCheckUrl("https://example.com/", safety.SB_INITIAL_ALLOWLIST).ok, false);
  assert.equal(safety.sbCheckUrl("https://chase.com/", ["chase.com"]).ok, false);
  assert.equal(safety.sbCheckUrl("not a url", safety.SB_INITIAL_ALLOWLIST).ok, false);
});
