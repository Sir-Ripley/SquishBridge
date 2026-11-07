"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createDriver } = require("../lib/cdp");
const safety = require("../lib/safety");
const dom = require("../lib/dom");

const ALLOW = ["github.com"];

function makeChrome({ tab, attachError = null, methods = {} }) {
  const calls = [];
  const chrome = {
    calls,
    runtime: {},
    tabs: {
      get: async (id) => {
        calls.push(["tabs.get", id]);
        if (!tab || id !== tab.id) throw new Error("No tab with id: " + id);
        return { ...tab };
      },
    },
    debugger: {
      attach: (target, version, cb) => {
        calls.push(["attach", target.tabId, version]);
        setImmediate(() => {
          if (attachError) chrome.runtime.lastError = { message: attachError };
          cb();
          delete chrome.runtime.lastError;
        });
      },
      detach: async (target) => {
        calls.push(["detach", target.tabId]);
      },
      sendCommand: (target, method, params, cb) => {
        calls.push([method, params || {}]);
        setImmediate(() => {
          const handler = methods[method];
          if (!handler) {
            chrome.runtime.lastError = { message: `No handler for ${method}` };
            cb();
            delete chrome.runtime.lastError;
            return;
          }
          cb(handler(params || {}));
        });
      },
    },
  };
  return chrome;
}

function driver(chrome, session) {
  return createDriver({
    chromeApi: chrome,
    getSession: async () => session,
    getAllowlist: async () => ALLOW,
    condense: dom.sbCondenseAXTree,
    checkUrl: safety.sbCheckUrl,
  });
}

const TAB = { id: 7, url: "https://github.com/octocat", title: "GitHub", status: "complete" };

test("refuses without an active session and never touches the debugger", async () => {
  const chrome = makeChrome({ tab: TAB });
  const d = driver(chrome, { active: false, tabId: null });
  await assert.rejects(d.execute("get_state", {}), /no active session/);
  assert.ok(!chrome.calls.some((c) => c[0] === "attach"));
});

test("refuses when the shared tab drifted off the allowlist", async () => {
  const chrome = makeChrome({ tab: { ...TAB, url: "https://evil.com/" } });
  const d = driver(chrome, { active: true, tabId: TAB.id });
  await assert.rejects(d.execute("get_state", {}), /refused: origin not allowlisted/);
  assert.ok(!chrome.calls.some((c) => c[0] === "attach"));
});

test("get_state reports url, title and loading flag", async () => {
  const chrome = makeChrome({ tab: { ...TAB, status: "loading" } });
  const d = driver(chrome, { active: true, tabId: TAB.id });
  assert.deepEqual(await d.execute("get_state", {}), {
    url: TAB.url,
    title: TAB.title,
    loading: true,
  });
});

test("navigate gates the target, then drives Page.navigate", async () => {
  const chrome = makeChrome({ tab: TAB, methods: { "Page.navigate": () => ({}) } });
  const d = driver(chrome, { active: true, tabId: TAB.id });
  assert.deepEqual(
    await d.execute("navigate", { url: "https://github.com/new" }),
    { url: "https://github.com/new" }
  );
  await assert.rejects(d.execute("navigate", { url: "https://evil.com/" }), /refused: origin not allowlisted/);
  await assert.rejects(d.execute("navigate", {}), /missing-url/);
  const navigated = chrome.calls.filter((c) => c[0] === "Page.navigate");
  assert.equal(navigated.length, 1);
  assert.deepEqual(navigated[0][1], { url: "https://github.com/new" });
});

test("dom_snapshot condenses the AX tree and rebuilds refs per snapshot", async () => {
  const tree = {
    nodes: [
      { role: { value: "button" }, name: { value: "New" }, backendDOMNodeId: 5 },
      { role: { value: "StaticText" }, name: { value: "" } },
    ],
  };
  const chrome = makeChrome({ tab: TAB, methods: { "Accessibility.getFullAXTree": () => tree } });
  const d = driver(chrome, { active: true, tabId: TAB.id });
  const snap = await d.execute("dom_snapshot", {});
  assert.equal(snap.url, TAB.url);
  assert.equal(snap.title, TAB.title);
  assert.deepEqual(snap.nodes, [{ ref: "1", role: "button", name: "New" }]);
  assert.deepEqual(d.getRefs(), { 1: 5 });
});

test("screenshot returns base64; empty captures raise", async () => {
  const good = makeChrome({ tab: TAB, methods: { "Page.captureScreenshot": () => ({ data: "aGVsbG8=" }) } });
  const d = driver(good, { active: true, tabId: TAB.id });
  assert.deepEqual(await d.execute("screenshot", {}), { pngBase64: "aGVsbG8=" });

  const bad = makeChrome({ tab: TAB, methods: { "Page.captureScreenshot": () => ({}) } });
  await assert.rejects(driver(bad, { active: true, tabId: TAB.id }).execute("screenshot", {}), /empty screenshot/);
});

test("M3 hands and unknown commands fail closed", async () => {
  const chrome = makeChrome({ tab: TAB });
  const d = driver(chrome, { active: true, tabId: TAB.id });
  await assert.rejects(d.execute("click", { ref: "1" }), /M3-hands/);
  await assert.rejects(d.execute("wait_for", {}), /M3-hands/);
  await assert.rejects(d.execute("rm_rf", {}), /unknown-command/);
});

test("attach failure surfaces and the session is left unattached", async () => {
  const chrome = makeChrome({ tab: TAB, attachError: "Another debugger is attached" });
  const d = driver(chrome, { active: true, tabId: TAB.id });
  await assert.rejects(d.execute("get_state", {}), /attach-failed/);
});

test("concurrent commands serialize on one debugger session", async () => {
  const order = [];
  const chrome = makeChrome({
    tab: TAB,
    methods: {
      "Page.navigate": () => (order.push("navigate"), {}),
      "Page.captureScreenshot": () => (order.push("shot"), { data: "eA==" }),
    },
  });
  const d = driver(chrome, { active: true, tabId: TAB.id });
  const [a, b] = await Promise.all([
    d.execute("navigate", { url: "https://github.com/a" }),
    d.execute("screenshot", {}),
  ]);
  assert.equal(a.url, "https://github.com/a");
  assert.equal(b.pngBase64, "eA==");
  assert.deepEqual(order, ["navigate", "shot"]);
  assert.equal(chrome.calls.filter((c) => c[0] === "attach").length, 1);
});
