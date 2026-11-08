"use strict";

/* Squish Bridge — install-readiness validator (M5).
 * Run: node tools/validate.js
 * Fails loudly if the extension is not shippable: bad manifest, missing
 * files, forbidden (credential-adjacent) APIs, or leaked secrets/artifacts.
 * Exit 0 = ready to load in Chrome. Exit 1 = fix the listed problems.
 */

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const EXT = path.join(ROOT, "extension");
const BRIDGE = path.join(ROOT, "bridge");

let failures = 0;
function check(ok, label, detail) {
  if (ok) {
    console.log(`ok   ${label}`);
  } else {
    failures += 1;
    console.log(`FAIL ${label}${detail ? " — " + detail : ""}`);
  }
}

function read(p) {
  return fs.readFileSync(p, "utf8");
}

// ---- Manifest ----

let manifest = null;
try {
  manifest = JSON.parse(read(path.join(EXT, "manifest.json")));
  check(true, "manifest.json parses");
} catch (err) {
  check(false, "manifest.json parses", err.message);
}

if (manifest) {
  check(manifest.manifest_version === 3, "manifest_version is 3");
  check(typeof manifest.name === "string" && !!manifest.version, "name + version present");

  const ALLOWED_PERMS = new Set(["debugger", "tabs", "storage", "alarms", "scripting"]);
  const FORBIDDEN_PERMS = ["cookies", "history", "downloads", "webRequest", "bookmarks", "clipboardRead", "identity", "proxy", "privacy", "management"];
  const perms = manifest.permissions || [];
  check(perms.every((p) => ALLOWED_PERMS.has(p)), "permissions match the §7 set", JSON.stringify(perms));
  check(!perms.some((p) => FORBIDDEN_PERMS.includes(p)), "no credential-adjacent permissions");
  check(!JSON.stringify(manifest).includes("<all_urls>"), "no blanket <all_urls>");

  const sw = manifest.background && manifest.background.service_worker;
  check(typeof sw === "string" && fs.existsSync(path.join(EXT, sw)), "service worker file exists", sw);
  const popup = manifest.action && manifest.action.default_popup;
  check(typeof popup === "string" && fs.existsSync(path.join(EXT, popup)), "popup file exists", popup);
  check(!!(manifest.commands && manifest.commands["stop-session"]), "stop-session command registered");

  const hosts = manifest.optional_host_permissions || [];
  check(
    hosts.length > 0 && hosts.every((h) => /^https:\/\/[^*]+\/\*$/.test(h)),
    "optional hosts are exact https origins (no wildcards)",
    JSON.stringify(hosts)
  );
}

// ---- Referenced files exist ----

const expected = [
  "background.js",
  "popup.html",
  "popup.css",
  "popup.js",
  "content-banner.js",
  "lib/safety.js",
  "lib/audit.js",
  "lib/link.js",
  "lib/dom.js",
  "lib/cdp.js",
];
for (const f of expected) {
  check(fs.existsSync(path.join(EXT, f)), `extension/${f} exists`);
}

// Every importScripts target must exist.
if (manifest) {
  const bg = read(path.join(EXT, manifest.background.service_worker));
  for (const m of bg.matchAll(/importScripts\(([^)]+)\)/g)) {
    for (const arg of m[1].matchAll(/"([^"]+)"/g)) {
      check(fs.existsSync(path.join(EXT, arg[1])), `importScripts target exists: ${arg[1]}`);
    }
  }
}

// Every popup <script src>/<link href> target must exist.
{
  const html = read(path.join(EXT, "popup.html"));
  for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    check(fs.existsSync(path.join(EXT, m[1])), `popup asset exists: ${m[1]}`);
  }
}

// ---- Forbidden APIs in shipped (non-test) extension code ----

const FORBIDDEN_CODE = [
  "Runtime.evaluate",
  "localStorage",
  "XMLHttpRequest",
  "chrome.cookies",
  "chrome.history",
  "chrome.webRequest",
  "chrome.downloads",
  "fetch(",
  "eval(",
];
function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "test" ? [] : jsFiles(p);
    return e.name.endsWith(".js") ? [p] : [];
  });
}
for (const f of jsFiles(EXT)) {
  const src = read(f);
  const rel = path.relative(ROOT, f);
  for (const bad of FORBIDDEN_CODE) {
    check(!src.includes(bad), `no ${bad} in ${rel}`);
  }
}

// ---- Bridge ----

check(fs.existsSync(path.join(BRIDGE, "package.json")), "bridge/package.json exists");
check(fs.existsSync(path.join(BRIDGE, "package-lock.json")), "bridge lockfile committed");
{
  const pkg = JSON.parse(read(path.join(BRIDGE, "package.json")));
  check(!!(pkg.scripts && pkg.scripts.start && pkg.scripts.test), "bridge has start + test scripts");
  check(!Object.keys(pkg.dependencies || {}).some((d) => ["express", "axios"].includes(d)), "no heavy bridge deps", JSON.stringify(Object.keys(pkg.dependencies || {})));
}

// ---- No secrets or runtime artifacts in the tree ----

for (const p of ["bridge/devices.json", "bridge/audit.log.jsonl", "extension/audit.log.jsonl"]) {
  check(!fs.existsSync(path.join(ROOT, p)), `${p} absent (never ship state)`);
}

console.log(failures === 0 ? "\nREADY: extension is installable." : `\nNOT READY: ${failures} problem(s).`);
process.exit(failures === 0 ? 0 : 1);
