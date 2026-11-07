"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { issueToken, hashToken, tokensEqual } = require("../lib/tokens");

test("issued tokens are unique; hashes are stable hex; compare is exact", () => {
  const a = issueToken();
  const b = issueToken();
  assert.notEqual(a, b);
  assert.match(hashToken(a), /^[0-9a-f]{64}$/);
  assert.equal(hashToken(a), hashToken(a));
  assert.ok(tokensEqual(hashToken(a), hashToken(a)));
  assert.ok(!tokensEqual(hashToken(a), hashToken(b)));
});
