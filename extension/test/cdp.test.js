"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createDriver } = require("../lib/cdp");
const safety = require("../lib/safety");
const dom = require("../lib/dom");

const ALLOW = ["github.com"];

function makeChrome({ tab, tabs = null, attachError = null, methods = {} }) {
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
      query: async () => {
        calls.push(["tabs.query"]);
        return (tabs === null ? (tab ? [tab] : []) : tabs).map((t) => ({ ...t }));
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

function driver(chrome, session, { openMode = false, allowlist = ALLOW } = {}) {
  return createDriver({
    chromeApi: chrome,
    getSession: async () => session,
    getAllowlist: async () => allowlist,
    getOpenMode: async () => openMode,
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

test("unknown commands fail closed", async () => {
  const chrome = makeChrome({ tab: TAB });
  const d = driver(chrome, { active: true, tabId: TAB.id });
  await assert.rejects(d.execute("rm_rf", {}), /unknown-command/);
});

const HANDS_TREE = {
  nodes: [
    { role: { value: "button" }, name: { value: "Go" }, backendDOMNodeId: 5 },
    { role: { value: "textbox" }, name: { value: "Search" }, backendDOMNodeId: 9 },
  ],
};

function handsChrome(overrides = {}) {
  return makeChrome({
    tab: TAB,
    methods: {
      "Accessibility.getFullAXTree": () => HANDS_TREE,
      "DOM.resolveNode": ({ backendNodeId }) => ({ object: { objectId: "obj-" + backendNodeId } }),
      "DOM.scrollIntoViewIfNeeded": () => ({}),
      "DOM.getContentQuads": () => ({ quads: [[0, 0, 100, 0, 100, 40, 0, 40]] }),
      "DOM.focus": () => ({}),
      "Input.dispatchMouseEvent": () => ({}),
      "Input.dispatchKeyEvent": () => ({}),
      "Input.insertText": () => ({}),
      "Page.getLayoutMetrics": () => ({ cssVisualViewport: { pageX: 400, pageY: 300 } }),
      ...overrides,
    },
  });
}

async function handsDriver(chrome) {
  const d = driver(chrome, { active: true, tabId: TAB.id });
  await d.execute("dom_snapshot", {}); // builds refs {1: 5, 2: 9}
  return d;
}

test("click by ref scrolls, resolves the center, and presses", async () => {
  const chrome = handsChrome();
  const d = await handsDriver(chrome);
  assert.deepEqual(await d.execute("click", { ref: "1" }), { clicked: true });
  const methods = chrome.calls.map((c) => c[0]);
  assert.deepEqual(methods.filter((m) => m === "DOM.resolveNode"), ["DOM.resolveNode"]);
  const pressed = chrome.calls.filter((c) => c[0] === "Input.dispatchMouseEvent");
  assert.deepEqual(pressed.map((c) => c[1].type), ["mousePressed", "mouseReleased"]);
  assert.equal(pressed[0][1].x, 50);
  assert.equal(pressed[0][1].y, 20);
});

test("click by coordinates skips resolution; bad clicks refuse", async () => {
  const chrome = handsChrome();
  const d = await handsDriver(chrome);
  assert.deepEqual(await d.execute("click", { x: 10, y: 20 }), { clicked: true });
  assert.ok(!chrome.calls.some((c) => c[0] === "DOM.resolveNode"));
  await assert.rejects(d.execute("click", { ref: "99" }), /unknown-ref/);
  await assert.rejects(d.execute("click", {}), /needs \{ ref \} or \{ x, y \}/);
});

test("click on a stale ref says to re-snapshot, not retry", async () => {
  const chrome = makeChrome({
    tab: TAB,
    methods: {
      "Accessibility.getFullAXTree": () => HANDS_TREE,
      "DOM.resolveNode": () => {
        throw new Error("No node with given id found");
      },
    },
  });
  // Throw through the callback path like a real CDP error.
  chrome.debugger.sendCommand = (target, method, params, cb) => {
    chrome.calls.push([method, params || {}]);
    setImmediate(() => {
      if (method === "DOM.resolveNode") {
        chrome.runtime.lastError = { message: "No node with given id found" };
        cb();
        delete chrome.runtime.lastError;
      } else if (method === "Accessibility.getFullAXTree") {
        cb(HANDS_TREE);
      } else {
        cb({});
      }
    });
  };
  const d = driver(chrome, { active: true, tabId: TAB.id });
  await d.execute("dom_snapshot", {});
  await assert.rejects(d.execute("click", { ref: "1" }), /stale-ref/);
});

test("type appends, fill selects-all first", async () => {
  const chrome = handsChrome();
  const d = await handsDriver(chrome);
  assert.deepEqual(await d.execute("type", { ref: "2", text: "hi" }), { typed: true });
  let keys = chrome.calls.filter((c) => c[0] === "Input.dispatchKeyEvent");
  assert.equal(keys.length, 0);
  const inserts = chrome.calls.filter((c) => c[0] === "Input.insertText");
  assert.deepEqual(inserts[0][1], { text: "hi" });

  await d.execute("fill", { ref: "2", text: "bye" });
  keys = chrome.calls.filter((c) => c[0] === "Input.dispatchKeyEvent");
  assert.deepEqual(keys.map((c) => c[1].type), ["rawKeyDown", "keyUp"]);
  assert.equal(keys[0][1].modifiers, 2);
  await assert.rejects(d.execute("type", { ref: "2" }), /needs \{ ref, text \}/);
  await assert.rejects(d.execute("type", { text: "x" }), /needs \{ ref, text \}/);
});

test("press_key handles characters, named keys, and rejects the rest", async () => {
  const chrome = handsChrome();
  const d = await handsDriver(chrome);
  assert.deepEqual(await d.execute("press_key", { key: "Enter" }), { pressed: true });
  assert.deepEqual(await d.execute("press_key", { key: "a" }), { pressed: true });
  await assert.rejects(d.execute("press_key", { key: "F13" }), /unknown key/);
  await assert.rejects(d.execute("press_key", {}), /needs \{ key \}/);
  const keys = chrome.calls.filter((c) => c[0] === "Input.dispatchKeyEvent");
  assert.equal(keys[0][1].windowsVirtualKeyCode, 13);
  assert.equal(keys[2][1].text, "a");
});

test("scroll defaults to a page-down at viewport center; refs scroll in place", async () => {
  const chrome = handsChrome();
  const d = await handsDriver(chrome);
  assert.deepEqual(await d.execute("scroll", {}), { scrolled: true });
  let wheels = chrome.calls.filter((c) => c[0] === "Input.dispatchMouseEvent");
  assert.equal(wheels.length, 1);
  assert.deepEqual(
    { x: wheels[0][1].x, y: wheels[0][1].y, deltaY: wheels[0][1].deltaY },
    { x: 400, y: 300, deltaY: 400 }
  );
  await d.execute("scroll", { ref: "1", deltaY: -200 });
  wheels = chrome.calls.filter((c) => c[0] === "Input.dispatchMouseEvent");
  assert.deepEqual({ x: wheels[1][1].x, deltaY: wheels[1][1].deltaY }, { x: 50, deltaY: -200 });
});

test("wait_for finds text and refs, times out loudly, validates args", async () => {
  const chrome = handsChrome();
  const d = await handsDriver(chrome);
  assert.deepEqual(await d.execute("wait_for", { text: "sea" }), { found: true });
  assert.deepEqual(await d.execute("wait_for", { ref: "2" }), { found: true });
  await assert.rejects(d.execute("wait_for", {}), /needs \{ ref \} or \{ text \}/);
  await assert.rejects(d.execute("wait_for", { text: "zzz-no-such-thing", timeoutMs: 1000 }), /wait-timeout/);
});

test("attach failure surfaces and the session is left unattached", async () => {
  const chrome = makeChrome({ tab: TAB, attachError: "Another debugger is attached" });
  const d = driver(chrome, { active: true, tabId: TAB.id });
  await assert.rejects(d.execute("get_state", {}), /attach-failed/);
});

test("list_tabs needs no session and reports origin/title/drivable, never full URLs", async () => {
  const tabs = [
    { id: 7, url: "https://github.com/octocat?tab=repos", title: "GitHub", status: "complete" },
    { id: 9, url: "https://example.com/some/path?q=1", title: "Example", status: "complete" },
    { id: 11, url: "chrome://extensions/", title: "Extensions", status: "complete" },
  ];
  const chrome = makeChrome({ tab: tabs[0], tabs });
  const d = driver(chrome, { active: false, tabId: null });
  const res = await d.execute("list_tabs", {});
  assert.deepEqual(res, {
    tabs: [
      { tabId: 7, title: "GitHub", origin: "https://github.com", shared: false, drivable: true },
      { tabId: 9, title: "Example", origin: "https://example.com", shared: false, drivable: false },
      { tabId: 11, title: "Extensions", origin: "", shared: false, drivable: false },
    ],
  });
  assert.ok(!JSON.stringify(res).includes("?tab=repos"), "query strings must not leak");
  assert.ok(!chrome.calls.some((c) => c[0] === "attach"), "listing never attaches the debugger");
});

test("list_tabs marks the shared tab and honors open mode for drivable", async () => {
  const tabs = [
    { id: 7, url: "https://github.com/octocat", title: "GitHub", status: "complete" },
    { id: 9, url: "https://example.com/", title: "Example", status: "complete" },
  ];
  const chrome = makeChrome({ tab: tabs[0], tabs });
  const d = driver(chrome, { active: true, tabId: 9 }, { openMode: true });
  const res = await d.execute("list_tabs", {});
  assert.deepEqual(res.tabs.map((t) => [t.tabId, t.shared, t.drivable]), [
    [7, false, true],
    [9, true, true],
  ]);
});

test("open mode lets commands run off-allowlist but never off-denylist", async () => {
  const chrome = makeChrome({
    tab: { ...TAB, url: "https://example.com/" },
    methods: { "Page.navigate": () => ({}) },
  });
  const d = driver(chrome, { active: true, tabId: TAB.id }, { openMode: true });
  assert.deepEqual(await d.execute("get_state", {}), {
    url: "https://example.com/",
    title: TAB.title,
    loading: false,
  });
  assert.deepEqual(await d.execute("navigate", { url: "https://other.example/" }), {
    url: "https://other.example/",
  });

  const denied = makeChrome({ tab: { ...TAB, url: "https://chase.com/" } });
  await assert.rejects(
    driver(denied, { active: true, tabId: TAB.id }, { openMode: true }).execute("get_state", {}),
    /refused: denylisted origin/
  );
});

test("click accepts button and clickCount; garbage refuses", async () => {
  const chrome = handsChrome();
  const d = await handsDriver(chrome);
  assert.deepEqual(await d.execute("click", { ref: "1", button: "right", clickCount: 2 }), { clicked: true });
  const pressed = chrome.calls.filter((c) => c[0] === "Input.dispatchMouseEvent");
  assert.deepEqual(pressed.map((c) => c[1].button), ["right", "right"]);
  assert.deepEqual(pressed.map((c) => c[1].clickCount), [2, 2]);
  await assert.rejects(d.execute("click", { ref: "1", button: "sideways" }), /unknown button/);
  await assert.rejects(d.execute("click", { ref: "1", clickCount: 9 }), /clickCount/);
});

test("hover moves the mouse without pressing", async () => {
  const chrome = handsChrome();
  const d = await handsDriver(chrome);
  assert.deepEqual(await d.execute("hover", { ref: "1" }), { hovered: true });
  assert.deepEqual(await d.execute("hover", { x: 5, y: 6 }), { hovered: true });
  const moves = chrome.calls.filter((c) => c[0] === "Input.dispatchMouseEvent");
  assert.deepEqual(moves.map((c) => c[1].type), ["mouseMoved", "mouseMoved"]);
  assert.deepEqual([moves[0][1].x, moves[0][1].y], [50, 20]);
  await assert.rejects(d.execute("hover", {}), /needs \{ ref \} or \{ x, y \}/);
});

test("reload, back, and forward drive history", async () => {
  const chrome = makeChrome({
    tab: TAB,
    methods: {
      "Page.reload": () => ({}),
      "Page.getNavigationHistory": () => ({
        currentIndex: 1,
        entries: [{ id: 1, url: "https://github.com/a" }, { id: 2, url: TAB.url }, { id: 3, url: "https://github.com/b" }],
      }),
      "Page.navigateToHistoryEntry": () => ({}),
    },
  });
  const d = driver(chrome, { active: true, tabId: TAB.id });
  assert.deepEqual(await d.execute("reload", {}), { reloaded: true });
  assert.deepEqual(await d.execute("back", {}), { navigated: true });
  assert.deepEqual(await d.execute("forward", {}), { navigated: true });
  const entries = chrome.calls.filter((c) => c[0] === "Page.navigateToHistoryEntry");
  assert.deepEqual(entries.map((c) => c[1]), [{ entryId: 1 }, { entryId: 3 }]);

  const single = makeChrome({
    tab: TAB,
    methods: { "Page.getNavigationHistory": () => ({ currentIndex: 0, entries: [{ id: 1, url: TAB.url }] }) },
  });
  const d2 = driver(single, { active: true, tabId: TAB.id });
  await assert.rejects(d2.execute("back", {}), /no back history/);
  await assert.rejects(d2.execute("forward", {}), /no forward history/);
});

test("back/forward refuse targets that fail the policy gate", async () => {
  const chrome = makeChrome({
    tab: TAB,
    methods: {
      "Page.getNavigationHistory": () => ({
        currentIndex: 1,
        entries: [{ id: 1, url: "https://chase.com/" }, { id: 2, url: TAB.url }, { id: 3, url: "https://evil.com/" }],
      }),
      "Page.navigateToHistoryEntry": () => ({}),
    },
  });
  const d = driver(chrome, { active: true, tabId: TAB.id });
  await assert.rejects(d.execute("back", {}), /refused: denylisted origin/);
  await assert.rejects(d.execute("forward", {}), /refused: origin not allowlisted/);
  assert.ok(!chrome.calls.some((c) => c[0] === "Page.navigateToHistoryEntry"), "gated walk never runs");
});

test("scroll accepts dx/dy aliases for deltaX/deltaY", async () => {
  const chrome = handsChrome();
  const d = await handsDriver(chrome);
  await d.execute("scroll", { dx: 10, dy: -50 });
  const wheels = chrome.calls.filter((c) => c[0] === "Input.dispatchMouseEvent");
  assert.deepEqual({ x: wheels[0][1].x, deltaX: wheels[0][1].deltaX, deltaY: wheels[0][1].deltaY }, { x: 400, deltaX: 10, deltaY: -50 });
});

test("click validates button/count before touching the page", async () => {
  const chrome = handsChrome();
  const d = await handsDriver(chrome);
  const cdpCalls = () => chrome.calls.filter((c) => c[0] !== "tabs.get").length;
  const before = cdpCalls();
  await assert.rejects(d.execute("click", { ref: "1", button: "sideways" }), /unknown button/);
  await assert.rejects(d.execute("click", { ref: "1", clickCount: 9 }), /clickCount/);
  assert.equal(cdpCalls(), before, "no CDP ran for invalid clicks");
});

test("pdf prints the page; empty prints raise", async () => {
  const good = makeChrome({ tab: TAB, methods: { "Page.printToPDF": () => ({ data: "cGRm" }) } });
  assert.deepEqual(await driver(good, { active: true, tabId: TAB.id }).execute("pdf", {}), {
    pdfBase64: "cGRm",
  });
  assert.deepEqual(good.calls.filter((c) => c[0] === "Page.printToPDF")[0][1], { printBackground: true });
  const bad = makeChrome({ tab: TAB, methods: { "Page.printToPDF": () => ({}) } });
  await assert.rejects(driver(bad, { active: true, tabId: TAB.id }).execute("pdf", {}), /empty pdf/);
});

test("screenshot fullPage captures beyond the viewport", async () => {
  const chrome = makeChrome({ tab: TAB, methods: { "Page.captureScreenshot": () => ({ data: "eA==" }) } });
  const d = driver(chrome, { active: true, tabId: TAB.id });
  await d.execute("screenshot", { fullPage: true });
  const shots = chrome.calls.filter((c) => c[0] === "Page.captureScreenshot");
  assert.deepEqual(shots[0][1], { format: "png", captureBeyondViewport: true });
});

test("press_key passes modifiers for chords", async () => {
  const chrome = handsChrome();
  const d = await handsDriver(chrome);
  assert.deepEqual(await d.execute("press_key", { key: "c", ctrl: true }), { pressed: true });
  const keys = chrome.calls.filter((c) => c[0] === "Input.dispatchKeyEvent");
  assert.equal(keys[0][1].modifiers, 2);
  assert.equal(keys[0][1].windowsVirtualKeyCode, 67);
  assert.deepEqual(await d.execute("press_key", { key: "Enter", shift: true }), { pressed: true });
  const again = chrome.calls.filter((c) => c[0] === "Input.dispatchKeyEvent");
  assert.equal(again[2][1].modifiers, 8);
});

test("upload_file sets the file input to a user-named local path", async () => {
  const chrome = handsChrome({ "DOM.setFileInputFiles": () => ({}) });
  const d = await handsDriver(chrome);
  assert.deepEqual(await d.execute("upload_file", { ref: "2", path: "C:\\Users\\rodney\\report.pdf" }), {
    uploaded: true,
    file: "report.pdf",
  });
  const set = chrome.calls.filter((c) => c[0] === "DOM.setFileInputFiles");
  assert.equal(set.length, 1);
  assert.deepEqual(set[0][1].files, ["C:\\Users\\rodney\\report.pdf"]);
  assert.ok(set[0][1].objectId, "targets the resolved input element");
  await assert.rejects(d.execute("upload_file", { ref: "2" }), /needs \{ ref, path \}/);
  await assert.rejects(d.execute("upload_file", { ref: "99", path: "x" }), /unknown-ref/);
});

test("evaluate returns by value and maps undefined to null", async () => {
  const chrome = makeChrome({
    tab: TAB,
    methods: { "Runtime.evaluate": () => ({ result: { type: "string", value: "hi" } }) },
  });
  const d = driver(chrome, { active: true, tabId: TAB.id });
  assert.deepEqual(await d.execute("evaluate", { expression: "document.title" }), { value: "hi" });
  const calls = chrome.calls.filter((c) => c[0] === "Runtime.evaluate");
  assert.deepEqual(calls[0][1], { expression: "document.title", returnByValue: true, awaitPromise: false });
  await d.execute("evaluate", { expression: "p", awaitPromise: true });
  assert.equal(chrome.calls.filter((c) => c[0] === "Runtime.evaluate")[1][1].awaitPromise, true);
  await assert.rejects(d.execute("evaluate", {}), /needs \{ expression \}/);
  await assert.rejects(d.execute("evaluate", { expression: "  " }), /needs \{ expression \}/);

  const undef = makeChrome({
    tab: TAB,
    methods: { "Runtime.evaluate": () => ({ result: { type: "undefined" } }) },
  });
  assert.deepEqual(await driver(undef, { active: true, tabId: TAB.id }).execute("evaluate", { expression: "void 0" }), {
    value: null,
  });
});

test("evaluate maps page exceptions and refuses oversized results", async () => {
  const throwing = makeChrome({
    tab: TAB,
    methods: {
      "Runtime.evaluate": () => ({
        exceptionDetails: { text: "boom", exception: { description: "Error: boom" } },
      }),
    },
  });
  await assert.rejects(
    driver(throwing, { active: true, tabId: TAB.id }).execute("evaluate", { expression: "x" }),
    /evaluate threw: Error: boom/
  );
  const huge = makeChrome({
    tab: TAB,
    methods: { "Runtime.evaluate": () => ({ result: { type: "string", value: "x".repeat(200000) } }) },
  });
  await assert.rejects(
    driver(huge, { active: true, tabId: TAB.id }).execute("evaluate", { expression: "x" }),
    /result too large/
  );
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
