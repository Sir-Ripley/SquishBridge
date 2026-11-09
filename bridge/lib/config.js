"use strict";

/* Squish Bridge — persisted server config (v0.6 P0 #2).
 *
 * The 2026-11-09 outage was a bind footgun: a hand restart silently bound
 * loopback-only (or failed outright), the extension looked healthy locally,
 * and Squish's tailnet probes died with empty replies. The fix has three
 * parts, all here:
 *
 *  1. bridge/bridge.config.json persists host/port/trust on first boot, so
 *     restarts are identical with zero env vars (npm start just works).
 *  2. Precedence is env > file > defaults, so one-off overrides still win.
 *  3. verifyBind() checks the resolved bind against the machine's actual
 *     addresses at startup and SHOUTS when Squish can't reach us.
 *
 * Pure functions only (plus explicit file helpers) so the whole module is
 * unit-testable. The library path (require) never touches the file — only
 * the boot path (require.main) ensures/loads it, keeping tests hermetic.
 */

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_CONFIG_FILE = path.join(__dirname, "..", "bridge.config.json");

const DEFAULTS = {
  host: "0.0.0.0",
  port: 3031,
  trustedIps: ["100.64.214.38"],
  trustTailnet: true,
};

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const BIND_ALL = new Set(["0.0.0.0", "::"]);

// Read + parse the config file. Never throws: a missing file yields {} with
// no error (first boot creates it); a malformed one yields {} plus the error
// so the caller can warn and fall back to defaults.
function loadConfigFile(file) {
  const target = file || DEFAULT_CONFIG_FILE;
  let raw = null;
  try {
    raw = fs.readFileSync(target, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return { data: {}, error: null };
    return { data: {}, error: String((err && err.message) || err) };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { data: {}, error: "config root must be a JSON object" };
    }
    return { data: parsed, error: null };
  } catch (err) {
    return { data: {}, error: "config is not valid JSON: " + String((err && err.message) || err) };
  }
}

// First boot: write the defaults file so the operator can see and edit the
// effective config. Returns { created, data, error }; existing files are
// never overwritten.
function ensureConfigFile(file) {
  const target = file || DEFAULT_CONFIG_FILE;
  if (fs.existsSync(target)) return { created: false, ...loadConfigFile(target) };
  const data = {
    host: DEFAULTS.host,
    port: DEFAULTS.port,
    trustedIps: [...DEFAULTS.trustedIps],
    trustTailnet: DEFAULTS.trustTailnet,
  };
  try {
    fs.writeFileSync(target, JSON.stringify(data, null, 2) + "\n", "utf8");
  } catch (err) {
    return { created: false, data: {}, error: String((err && err.message) || err) };
  }
  return { created: true, data, error: null };
}

function cleanHost(v) {
  const h = String(v === undefined || v === null ? "" : v).trim();
  return h || null;
}

function cleanPort(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : null;
}

function cleanIps(v) {
  if (!Array.isArray(v)) return null;
  const out = [...new Set(v.map((s) => String(s).trim()).filter(Boolean))];
  return out;
}

function envFlagFalse(v) {
  const s = String(v === undefined || v === null ? "" : v).trim().toLowerCase();
  return s === "0" || s === "false" || s === "no";
}

// Precedence: env > file > defaults. `env` defaults to process.env (pass a
// stub in tests).
function resolveConfig({ fileData = {}, env = process.env } = {}) {
  const file = fileData && typeof fileData === "object" ? fileData : {};

  const envHost = env && cleanHost(env.SQUISH_BRIDGE_HOST);
  const host = envHost || cleanHost(file.host) || DEFAULTS.host;

  const envPortRaw = env && env.SQUISH_BRIDGE_PORT !== undefined && String(env.SQUISH_BRIDGE_PORT).trim() !== ""
    ? cleanPort(env.SQUISH_BRIDGE_PORT)
    : null;
  const port = envPortRaw || cleanPort(file.port) || DEFAULTS.port;

  let trustedIps = null;
  if (env && String(env.SQUISH_BRIDGE_TRUSTED_IPS || "").trim() !== "") {
    trustedIps = [...new Set(String(env.SQUISH_BRIDGE_TRUSTED_IPS).split(",").map((s) => s.trim()).filter(Boolean))];
  } else {
    trustedIps = cleanIps(file.trustedIps) || [...DEFAULTS.trustedIps];
  }

  let trustTailnet = null;
  if (env && String(env.SQUISH_BRIDGE_TRUST_TAILNET || "").trim() !== "") {
    trustTailnet = !envFlagFalse(env.SQUISH_BRIDGE_TRUST_TAILNET);
  } else if (typeof file.trustTailnet === "boolean") {
    trustTailnet = file.trustTailnet;
  } else {
    trustTailnet = DEFAULTS.trustTailnet;
  }

  return { host, port, trustedIps, trustTailnet };
}

// Startup self-check: compare the resolved bind against the machine's real
// addresses. `tailnetAddrs` is the subset of `localAddrs` inside 100.64/10
// (computed by the caller with isTailnetAddr). Returns warning strings —
// empty when the agent path is plausibly reachable. The loopback-only case
// is THE 2026-11-09 footgun, so it names the fix, not just the symptom.
function verifyBind(host, localAddrs, tailnetAddrs) {
  const locals = Array.isArray(localAddrs) ? localAddrs : [];
  const tails = Array.isArray(tailnetAddrs) ? tailnetAddrs : [];
  const warnings = [];
  if (LOOPBACK_HOSTS.has(String(host).trim())) {
    if (tails.length) {
      warnings.push(
        `BOUND LOOPBACK-ONLY (host=${host}) but this machine has tailnet address(es) ${tails.join(", ")} — ` +
          "Squish's tailnet commands CANNOT reach this server. Fix: unset SQUISH_BRIDGE_HOST " +
          "(bind-all is the default) or set the config host to 0.0.0.0, then restart."
      );
    }
    return warnings;
  }
  if (!BIND_ALL.has(String(host).trim()) && !locals.includes(String(host).trim())) {
    warnings.push(
      `host=${host} is not an address on this machine (seen: ${locals.join(", ") || "none"}) — ` +
        "the server may be unreachable. Fix: 0.0.0.0 (default) or a local address, then restart."
    );
  }
  if (BIND_ALL.has(String(host).trim()) && tails.length === 0) {
    warnings.push(
      "no tailnet (100.64.0.0/10) address detected on this machine — Tailscale may be down; " +
        "the agent path is unavailable until it is up (loopback pairing still works)."
    );
  }
  return warnings;
}

module.exports = {
  DEFAULT_CONFIG_FILE,
  DEFAULTS,
  loadConfigFile,
  ensureConfigFile,
  resolveConfig,
  verifyBind,
};
