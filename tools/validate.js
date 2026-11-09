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
  // Optional grants nothing at install: each origin is individually prompted
  // at runtime when the user adds/shares it. The single https wildcard makes
  // arbitrary origins requestable (MV3 only grants origins covered by a
  // manifest pattern); exact entries document the default allowlist.
  const OPTIONAL_WILDCARD = "https://*/*";
  check(
    hosts.length > 0 &&
      hosts.every((h) => h === OPTIONAL_WILDCARD || /^https:\/\/[^*]+\/\*$/.test(h)),
    "optional hosts are exact https origins + one documented https wildcard",
    JSON.stringify(hosts)
  );
  check(
    hosts.filter((h) => h === OPTIONAL_WILDCARD).length <= 1,
    "at most one optional wildcard"
  );
  check(
    !manifest.host_permissions || manifest.host_permissions.length === 0,
    "no static host_permissions (every grant is runtime + per-origin)"
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

// Every element id popup.js touches must exist in popup.html: a missing id
// nulls the lookup and kills the whole popup script on load.
{
  const html = read(path.join(EXT, "popup.html"));
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const js = read(path.join(EXT, "popup.js"));
  const used = [...js.matchAll(/\$\("([^"]+)"\)/g)].map((m) => m[1]);
  const missing = [...new Set(used)].filter((id) => !ids.has(id));
  check(used.length > 0, "popup.js element lookups found", `${used.length} lookups`);
  check(missing.length === 0, "every popup.js id exists in popup.html", JSON.stringify(missing));
}

// ---- Forbidden APIs in shipped (non-test) extension code ----

const FORBIDDEN_CODE = [
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

// Page JS exists only by Rodney's explicit approval (2026-11-09): the
// audited driver path in lib/cdp.js is the one place Runtime.evaluate may
// appear, so a stray eval channel can never slip in elsewhere.
{
  const users = jsFiles(EXT)
    .filter((f) => read(f).includes("Runtime.evaluate"))
    .map((f) => path.relative(ROOT, f).replace(/\\/g, "/"));
  check(
    users.length === 1 && users[0] === "extension/lib/cdp.js",
    "Runtime.evaluate only in extension/lib/cdp.js (audited driver path)",
    JSON.stringify(users)
  );
}

// ---- Tool scripts ----

// Windows PowerShell reads BOM-less .ps1 as the ANSI code page, so any
// non-ASCII byte (a stray em-dash) can break parsing outright. Keep
// tool scripts pure ASCII.
{
  const toolsDir = path.join(ROOT, "tools");
  for (const f of fs.readdirSync(toolsDir).filter((n) => n.endsWith(".ps1"))) {
    const buf = fs.readFileSync(path.join(toolsDir, f));
    const bad = buf.find((b) => b > 127);
    check(bad === undefined, `tools/${f} is ASCII-only`, bad === undefined ? "" : `byte ${bad}`);
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
