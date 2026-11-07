"use strict";

/* Squish Bridge — token helpers (M0 real, used by M1 pairing).
 * Device tokens are random 256-bit values (base64url). Only a SHA-256
 * hash is stored on the bridge; comparison is constant-time.
 */

const crypto = require("node:crypto");

function issueToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token), "utf8").digest("hex");
}

function tokensEqual(a, b) {
  const ab = Buffer.from(String(a), "utf8");
  const bb = Buffer.from(String(b), "utf8");
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

module.exports = { issueToken, hashToken, tokensEqual };
