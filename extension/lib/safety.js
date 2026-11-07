"use strict";

/* Squish Bridge — safety policy (M0).
 * Allowlist enforced in the extension. Denylist always wins.
 * Plain script (no modules) so the MV3 service worker and popup can
 * load it directly. Node-compatible export guard at the bottom for tests.
 */

const SB_INITIAL_ALLOWLIST = [
  "github.com",
  "kaggle.com",
  "notebooklm.google.com",
  "notebook.google.com",
];

// Substring/regex rules that always refuse, even if allowlisted.
const SB_DENYLIST = [
  /\.bank$/i,
  /\.creditunion$/i,
  /bankofamerica\./i,
  /chase\./i,
  /wellsfargo\./i,
  /citi\./i,
  /paypal\./i,
  /^1password\./i,
  /lastpass\./i,
  /bitwarden\./i,
  /dashlane\./i,
];

function sbNormalizeHost(urlOrHost) {
  let host = String(urlOrHost || "").trim().toLowerCase();
  if (!host) return "";
  if (!host.includes("://") && !host.startsWith("//")) {
    host = "https://" + host;
  }
  try {
    host = new URL(host).hostname.toLowerCase();
  } catch {
    return "";
  }
  // Strip one trailing dot ("github.com." -> "github.com").
  if (host.endsWith(".") && host.length > 1) host = host.slice(0, -1);
  return host;
}

// Exact host or any subdomain of an allowlisted origin ("gist.github.com" ok).
function sbIsAllowlisted(urlOrHost, allowlist) {
  const host = sbNormalizeHost(urlOrHost);
  if (!host) return false;
  const list = Array.isArray(allowlist) ? allowlist : SB_INITIAL_ALLOWLIST;
  return list.some((entry) => {
    const base = sbNormalizeHost(entry);
    if (!base) return false;
    return host === base || host.endsWith("." + base);
  });
}

function sbIsDenied(urlOrHost) {
  const host = sbNormalizeHost(urlOrHost);
  if (!host) return true; // Unparseable target: refuse.
  if (host === "localhost" || host === "127.0.0.1" || host === "[::1]") return true;
  if (host.endsWith(".localhost")) return true;
  if (host.startsWith("chrome") || host === "newtab") return true;
  return SB_DENYLIST.some((re) => re.test(host));
}

// Single gate every command path must call. Returns {ok:true} or {ok:false, reason}.
function sbCheckUrl(url, allowlist) {
  if (typeof url !== "string" || !url) {
    return { ok: false, reason: "missing-url" };
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "bad-url" };
  }
  if (parsed.protocol !== "https:") {
    return { ok: false, reason: "origin must be https" };
  }
  if (sbIsDenied(parsed.hostname)) {
    return { ok: false, reason: "denylisted origin" };
  }
  if (!sbIsAllowlisted(parsed.hostname, allowlist)) {
    return { ok: false, reason: "origin not allowlisted" };
  }
  return { ok: true };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    SB_INITIAL_ALLOWLIST,
    SB_DENYLIST,
    sbNormalizeHost,
    sbIsAllowlisted,
    sbIsDenied,
    sbCheckUrl,
  };
}
