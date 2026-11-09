"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const safety = require("../lib/safety");

test("initial allowlist covers the v0 mission origins", () => {
  for (const h of ["github.com", "gist.github.com", "kaggle.com", "notebooklm.google.com"]) {
    assert.ok(safety.sbIsAllowlisted(h, safety.SB_INITIAL_ALLOWLIST), h);
  }
});

test("initial allowlist covers supabase (console + marketing site)", () => {
  for (const h of ["supabase.com", "app.supabase.com", "xyzcompany.supabase.co"]) {
    assert.ok(!safety.sbIsDenied(h), h + " must not be denylisted");
  }
  for (const h of ["supabase.com", "docs.supabase.com", "app.supabase.com"]) {
    assert.ok(safety.sbIsAllowlisted(h, safety.SB_INITIAL_ALLOWLIST), h);
  }
  assert.equal(safety.sbCheckUrl("https://app.supabase.com/project/x", safety.SB_INITIAL_ALLOWLIST).ok, true);
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

test("open mode skips the allowlist but never the denylist or https rule", () => {
  const open = { openMode: true };
  assert.equal(safety.sbCheckUrl("https://example.com/", safety.SB_INITIAL_ALLOWLIST, open).ok, true);
  assert.equal(safety.sbCheckUrl("https://anything.example.org/a/b", ["github.com"], open).ok, true);
  assert.equal(safety.sbCheckUrl("https://chase.com/", safety.SB_INITIAL_ALLOWLIST, open).ok, false);
  assert.equal(safety.sbCheckUrl("http://example.com/", safety.SB_INITIAL_ALLOWLIST, open).ok, false);
  assert.equal(safety.sbCheckUrl("not a url", safety.SB_INITIAL_ALLOWLIST, open).ok, false);
  // Default stays closed: omitting options changes nothing.
  assert.equal(safety.sbCheckUrl("https://example.com/", safety.SB_INITIAL_ALLOWLIST).ok, false);
  assert.equal(safety.sbCheckUrl("https://example.com/", safety.SB_INITIAL_ALLOWLIST, {}).ok, false);
  assert.equal(safety.sbCheckUrl("https://example.com/", safety.SB_INITIAL_ALLOWLIST, { openMode: false }).ok, false);
});

test("sbPlanShareSite decides start vs add-and-start vs refused", () => {
  assert.deepEqual(safety.sbPlanShareSite("https://github.com/x", ["github.com"], {}), {
    action: "start",
    host: "github.com",
  });
  assert.deepEqual(safety.sbPlanShareSite("https://example.com/", ["github.com"], {}), {
    action: "add-and-start",
    host: "example.com",
  });
  assert.deepEqual(safety.sbPlanShareSite("https://example.com/", ["github.com"], { openMode: true }), {
    action: "start",
    host: "example.com",
  });
  for (const bad of ["https://chase.com/", "http://example.com/", "not a url", "", null]) {
    const plan = safety.sbPlanShareSite(bad, ["github.com"], { openMode: true });
    assert.equal(plan.action, "refused", String(bad));
    assert.ok(plan.reason, String(bad));
  }
  // Open mode never rescues a denylisted host.
  assert.equal(
    safety.sbPlanShareSite("https://chase.com/", ["github.com"], { openMode: true }).action,
    "refused"
  );
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
