"use strict";

/* Squish Bridge — pairing codes + device token store (M1).
 *
 * Pairing codes: short-lived (default 10 min), single-use, unambiguous
 * characters for typing from chat into the popup. A code burns after
 * MAX_ATTEMPTS failed tries. Codes live in memory only: a bridge restart
 * invalidates outstanding codes, which is safe (Squish just issues a new one).
 *
 * Device tokens: issued at exchange, 256-bit (see lib/tokens.js). The store
 * keeps ONLY the SHA-256 hash, plus install metadata. Backed by a JSON file
 * so devices survive bridge restarts; unpaired/revoked devices stay listed
 * as revoked so a leaked token can never be reactivated.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I/L
const CODE_GROUPS = [4, 4];
const DEFAULT_TTL_MS = 10 * 60 * 1000;
const MAX_TTL_MS = 30 * 60 * 1000;
const MAX_ATTEMPTS = 5;

function randomCode() {
  const letters = crypto.randomBytes(CODE_GROUPS[0] + CODE_GROUPS[1]);
  let s = "";
  for (const b of letters) s += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

function normalizeCode(code) {
  // Dashes and whitespace are formatting only: "abcd-1234", "ABCD1234" and
  // "abcd 1234" are the same code. Codes are stored under this form.
  return String(code || "").trim().toUpperCase().replace(/[\s-]+/g, "");
}

function createPairingStore() {
  return new Map(); // code -> { expiresAt, attempts, spent, createdAt }
}

function issueCode(store, { ttlMs = DEFAULT_TTL_MS, now = Date.now() } = {}) {
  const ttl = Math.min(Math.max(Number(ttlMs) || DEFAULT_TTL_MS, 60 * 1000), MAX_TTL_MS);
  let code = randomCode();
  while (store.has(normalizeCode(code))) code = randomCode();
  const createdAt = now;
  store.set(normalizeCode(code), { expiresAt: createdAt + ttl, attempts: 0, spent: false, createdAt });
  return { code, expiresAt: new Date(createdAt + ttl).toISOString() };
}

// Result: { ok:true } or { ok:false, error }. A successful call consumes
// the code. A failed call counts an attempt and burns the code at the limit.
function redeemCode(store, code, { now = Date.now() } = {}) {
  const key = normalizeCode(code);
  const rec = store.get(key);
  if (!rec || rec.spent) return { ok: false, error: "unknown-or-spent-code" };
  if (now > rec.expiresAt) {
    store.delete(key);
    return { ok: false, error: "code-expired" };
  }
  if (rec.attempts >= MAX_ATTEMPTS) {
    store.delete(key);
    return { ok: false, error: "code-locked" };
  }
  rec.spent = true;
  return { ok: true };
}

// Call when an exchange attempt fails validation (bad installId etc.) so the
// code is NOT silently left valid forever: counts as an attempt instead.
function failAttempt(store, code) {
  const key = normalizeCode(code);
  const rec = store.get(key);
  if (!rec) return;
  rec.attempts += 1;
  rec.spent = true; // code is single-try at exchange: a wrong-shaped request burns it
}

function pendingCount(store, { now = Date.now() } = {}) {
  let n = 0;
  for (const [code, rec] of store) {
    if (rec.spent || now > rec.expiresAt) store.delete(code);
    else n += 1;
  }
  return n;
}

// ---- Device store (hash at rest) ----

function loadDevices(file) {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const data = JSON.parse(raw);
    if (data && typeof data.devices === "object" && data.devices) return data.devices;
    return {};
  } catch (err) {
    if (err && err.code === "ENOENT") return {};
    throw err;
  }
}

function saveDevices(file, devices) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ devices }, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
}

function registerDevice(devices, installId, tokenHash, { now = Date.now() } = {}) {
  devices[installId] = {
    tokenHash,
    createdAt: new Date(now).toISOString(),
    revokedAt: null,
    lastSeenAt: null,
  };
  return devices[installId];
}

function findDeviceByHash(devices, tokenHash) {
  const { tokensEqual } = require("./tokens");
  for (const [installId, dev] of Object.entries(devices)) {
    if (!dev || dev.revokedAt) continue;
    if (tokensEqual(dev.tokenHash, tokenHash)) return { installId, ...dev };
  }
  return null;
}

function revokeDevice(devices, installId) {
  const dev = devices[installId];
  if (!dev || dev.revokedAt) return false;
  dev.revokedAt = new Date().toISOString();
  return true;
}

function touchDevice(devices, installId, { now = Date.now() } = {}) {
  const dev = devices[installId];
  if (dev) dev.lastSeenAt = new Date(now).toISOString();
}

function validInstallId(id) {
  return typeof id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(id);
}

module.exports = {
  CODE_GROUPS,
  DEFAULT_TTL_MS,
  MAX_TTL_MS,
  MAX_ATTEMPTS,
  createPairingStore,
  issueCode,
  redeemCode,
  failAttempt,
  pendingCount,
  normalizeCode,
  loadDevices,
  saveDevices,
  registerDevice,
  findDeviceByHash,
  revokeDevice,
  touchDevice,
  validInstallId,
};
