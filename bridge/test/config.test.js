"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const config = require("../lib/config");

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sb-cfg-")), "bridge.config.json");

test("resolveConfig defaults with no file and no env", () => {
  const c = config.resolveConfig({ fileData: {}, env: {} });
  assert.deepEqual(c, {
    host: "0.0.0.0",
    port: 3031,
    trustedIps: ["100.64.214.38"],
    trustTailnet: true,
  });
});

test("resolveConfig: file fills the middle, env wins every field", () => {
  const fileData = { host: "127.0.0.1", port: 4040, trustedIps: ["10.1.2.3"], trustTailnet: false };
  const fromFile = config.resolveConfig({ fileData, env: {} });
  assert.deepEqual(fromFile, { host: "127.0.0.1", port: 4040, trustedIps: ["10.1.2.3"], trustTailnet: false });

  const env = {
    SQUISH_BRIDGE_HOST: "  0.0.0.0 ",
    SQUISH_BRIDGE_PORT: "3031",
    SQUISH_BRIDGE_TRUSTED_IPS: "100.9.9.9, 100.9.9.10",
    SQUISH_BRIDGE_TRUST_TAILNET: "yes",
  };
  const fromEnv = config.resolveConfig({ fileData, env });
  assert.deepEqual(fromEnv, {
    host: "0.0.0.0",
    port: 3031,
    trustedIps: ["100.9.9.9", "100.9.9.10"],
    trustTailnet: true,
  });
});

test("resolveConfig: blank env falls through to file, junk falls to defaults", () => {
  const fileData = { host: "0.0.0.0", port: 3031, trustedIps: ["10.0.0.9"], trustTailnet: true };
  const c = config.resolveConfig({
    fileData,
    env: { SQUISH_BRIDGE_HOST: "   ", SQUISH_BRIDGE_TRUSTED_IPS: "" },
  });
  assert.equal(c.host, "0.0.0.0");
  assert.deepEqual(c.trustedIps, ["10.0.0.9"]);

  const junk = config.resolveConfig({ fileData: { host: "", port: "lots", trustedIps: "nope" }, env: {} });
  assert.equal(junk.host, "0.0.0.0");
  assert.equal(junk.port, 3031);
  assert.deepEqual(junk.trustedIps, ["100.64.214.38"]);

  for (const off of ["0", "false", "no", "  NO "]) {
    assert.equal(config.resolveConfig({ fileData: {}, env: { SQUISH_BRIDGE_TRUST_TAILNET: off } }).trustTailnet, false, off);
  }
});

test("ensureConfigFile creates defaults once, never overwrites", () => {
  const f = tmpFile();
  const first = config.ensureConfigFile(f);
  assert.equal(first.created, true);
  assert.equal(first.error, null);
  assert.deepEqual(JSON.parse(fs.readFileSync(f, "utf8")), {
    host: "0.0.0.0",
    port: 3031,
    trustedIps: ["100.64.214.38"],
    trustTailnet: true,
  });
  fs.writeFileSync(f, JSON.stringify({ host: "127.0.0.1" }), "utf8");
  const second = config.ensureConfigFile(f);
  assert.equal(second.created, false);
  assert.deepEqual(second.data, { host: "127.0.0.1" });
});

test("loadConfigFile: missing is fine, malformed reports without throwing", () => {
  const missing = config.loadConfigFile(tmpFile());
  assert.deepEqual(missing.data, {});
  assert.equal(missing.error, null);

  const bad = tmpFile();
  fs.writeFileSync(bad, "{not json", "utf8");
  const malformed = config.loadConfigFile(bad);
  assert.deepEqual(malformed.data, {});
  assert.match(malformed.error, /not valid JSON/);

  const arr = tmpFile();
  fs.writeFileSync(arr, "[1,2]", "utf8");
  assert.match(config.loadConfigFile(arr).error, /must be a JSON object/);
});

test("verifyBind: healthy bind-all is silent", () => {
  assert.deepEqual(config.verifyBind("0.0.0.0", ["100.87.226.76", "10.0.0.2"], ["100.87.226.76"]), []);
});

test("verifyBind: loopback-only with a tailnet present SHOUTS the fix", () => {
  const w = config.verifyBind("127.0.0.1", ["100.87.226.76"], ["100.87.226.76"]);
  assert.equal(w.length, 1);
  assert.match(w[0], /LOOPBACK-ONLY/);
  assert.match(w[0], /100\.87\.226\.76/);
  assert.match(w[0], /unset SQUISH_BRIDGE_HOST/);
});

test("verifyBind: loopback-only with no tailnet stays quiet (locked-down box)", () => {
  assert.deepEqual(config.verifyBind("127.0.0.1", [], []), []);
});

test("verifyBind: unknown specific host and missing tailnet warn", () => {
  const w = config.verifyBind("100.99.99.99", ["100.87.226.76"], ["100.87.226.76"]);
  assert.equal(w.length, 1);
  assert.match(w[0], /not an address on this machine/);

  const down = config.verifyBind("0.0.0.0", ["10.0.0.2"], []);
  assert.equal(down.length, 1);
  assert.match(down[0], /Tailscale may be down/);
});
