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

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    SB_WS_PATH,
    sbBackoffDelay,
    sbNormalizeBridgeUrl,
    sbSocketUrl,
    sbAuthMessage,
    sbIsAuthOk,
  };
}
