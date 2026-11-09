"use strict";

/* Squish Bridge — bridge-link helpers (M1).
 * Pure functions for pairing + socket bookkeeping. No chrome.* here, so
 * they load in the service worker AND under node for unit tests.
 */

const SB_WS_PATH = "/v1/extension";

// Reconnect backoff: 1s, 2s, 4s, … capped at 60s, ±25% jitter.
function sbBackoffDelay(attempt) {
  const n = Math.max(0, Math.floor(Number(attempt) || 0));
  const base = Math.min(1000 * 2 ** n, 60000);
  const jitter = base * 0.25 * (Math.random() * 2 - 1);
  return Math.round(base + jitter);
}

function sbNormalizeBridgeUrl(raw) {
  const s = String(raw || "").trim();
  if (!s) throw new Error("enter the bridge address, e.g. ws://127.0.0.1:3031");
  let url;
  try {
    url = new URL(s);
  } catch {
    throw new Error("bridge address must be a ws:// or wss:// URL");
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error("bridge address must be a ws:// or wss:// URL");
  }
  url.hash = "";
  let path = url.pathname.replace(/\/+$/, "");
  if (path && path !== "/") throw new Error("bridge address must be host:port only, no path");
  url.pathname = "/";
  return url.toString().replace(/\/$/, "");
}

function sbSocketUrl(bridgeUrl) {
  return sbNormalizeBridgeUrl(bridgeUrl) + SB_WS_PATH;
}

function sbAuthMessage(id, token, installId) {
  return { id: String(id), type: "auth", payload: { token, installId } };
}

function sbIsAuthOk(msg) {
  return !!msg && msg.ok === true && !!msg.result;
}

// v0.6 P0 #3, second light: how fresh is the Squish link? nowMs is the
// caller's clock, lastIso the server's last_command_at (or null when the
// server has seen no agent hit yet / the status refresh hasn't landed).
function sbLinkAgeLabel(nowMs, lastIso) {
  if (!lastIso) return "unknown";
  const t = Date.parse(lastIso);
  if (Number.isNaN(t)) return "unknown";
  const ageS = Math.max(0, Math.floor((Number(nowMs) - t) / 1000));
  if (ageS < 90) return `active ${ageS}s ago`;
  if (ageS < 300) return `active ${Math.floor(ageS / 60)}m ago`;
  if (ageS < 3600) return `silent ${Math.floor(ageS / 60)}m`;
  return `silent ${Math.floor(ageS / 3600)}h`;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    SB_WS_PATH,
    sbBackoffDelay,
    sbNormalizeBridgeUrl,
    sbSocketUrl,
    sbAuthMessage,
    sbIsAuthOk,
    sbLinkAgeLabel,
  };
}
