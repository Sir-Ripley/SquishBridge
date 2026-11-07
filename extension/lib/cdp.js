"use strict";

/* Squish Bridge — CDP driver (M2).
 * Executes bridge commands against the shared tab through chrome.debugger.
 * Takes the `chrome` API as a dependency so the exact same code runs in
 * the service worker and under node with a stub. No storage, no socket,
 * no globals here — session/allowlist/audit arrive as hooks.
 *
 * Hard rules enforced on every command:
 *  1. An active session with an explicitly shared tab must exist.
 *  2. The shared tab's current URL must pass the allowlist gate.
 *  3. `navigate` targets pass the gate too, before anything runs.
 */

const M3_HANDS = new Set(["click", "type", "fill", "press_key", "scroll", "wait_for"]);
const M2_EYES = new Set(["navigate", "screenshot", "dom_snapshot", "get_state"]);

function createDriver({ chromeApi, getSession, getAllowlist, condense, checkUrl }) {
  if (!chromeApi || !chromeApi.debugger || !chromeApi.tabs) throw new Error("driver needs chrome.debugger + chrome.tabs");
  for (const [name, fn] of [["getSession", getSession], ["getAllowlist", getAllowlist], ["condense", condense], ["checkUrl", checkUrl]]) {
    if (typeof fn !== "function") throw new Error(`driver needs a ${name} hook`);
  }

  let attachedTab = null;
  let refs = {};
  let tail = Promise.resolve();

  function send(tabId, method, params) {
    return new Promise((resolve, reject) => {
      chromeApi.debugger.sendCommand({ tabId }, method, params || {}, (result) => {
        const err = chromeApi.runtime && chromeApi.runtime.lastError;
        if (err) reject(new Error(err.message || String(err)));
        else resolve(result);
      });
    });
  }

  function attach(tabId) {
    return new Promise((resolve, reject) => {
      chromeApi.debugger.attach({ tabId }, "1.3", () => {
        const err = chromeApi.runtime && chromeApi.runtime.lastError;
        if (err) reject(new Error(err.message || String(err)));
        else resolve(true);
      });
    });
  }

  function detach(tabId) {
    return chromeApi.debugger.detach({ tabId }).catch(() => {});
  }

  // One CDP conversation at a time: parallel calls would interleave on the
  // same debugger session.
  function exclusive(fn) {
    const run = tail.then(fn, fn);
    tail = run.catch(() => {});
    return run;
  }

  async function ensureAttached(tabId) {
    if (attachedTab === tabId) return true;
    if (attachedTab !== null) {
      await detach(attachedTab);
      attachedTab = null;
    }
    try {
      await attach(tabId);
    } catch (err) {
      throw new Error("attach-failed: " + err.message);
    }
    attachedTab = tabId;
    return true;
  }

  async function sharedTab() {
    const session = await getSession();
    if (!session || !session.active || !Number.isInteger(session.tabId)) {
      throw new Error("refused: no active session");
    }
    const tab = await chromeApi.tabs.get(session.tabId).catch(() => null);
    if (!tab) throw new Error("refused: shared tab is gone");
    const check = checkUrl(tab.url || "", await getAllowlist());
    if (!check.ok) throw new Error("refused: " + check.reason);
    return tab;
  }

  async function execute(type, payload) {
    if (M3_HANDS.has(type)) throw new Error("arrives in M3-hands");
    if (!M2_EYES.has(type)) throw new Error("unknown-command: " + type);
    const tab = await sharedTab();
    return exclusive(async () => {
      await ensureAttached(tab.id);
      switch (type) {
        case "get_state": {
          const fresh = await chromeApi.tabs.get(tab.id).catch(() => tab);
          return { url: fresh.url || "", title: fresh.title || "", loading: fresh.status === "loading" };
        }
        case "navigate": {
          const url = payload && payload.url;
          if (typeof url !== "string" || !url) throw new Error("refused: missing-url");
          const check = checkUrl(url, await getAllowlist());
          if (!check.ok) throw new Error("refused: " + check.reason);
          await send(tab.id, "Page.navigate", { url });
          return { url };
        }
        case "screenshot": {
          const shot = await send(tab.id, "Page.captureScreenshot", { format: "png" });
          if (!shot || typeof shot.data !== "string") throw new Error("error: empty screenshot");
          return { pngBase64: shot.data };
        }
        case "dom_snapshot": {
          const tree = await send(tab.id, "Accessibility.getFullAXTree", {});
          const condensed = condense(tree && tree.nodes);
          refs = condensed.refs;
          const fresh = await chromeApi.tabs.get(tab.id).catch(() => tab);
          return {
            url: fresh.url || "",
            title: fresh.title || "",
            nodes: condensed.nodes,
            truncated: condensed.truncated,
          };
        }
      }
      throw new Error("unknown-command: " + type);
    });
  }

  // Called at Start so attach failures surface immediately, not mid-task.
  async function attachForSession(tabId) {
    await ensureAttached(tabId);
  }

  function reset() {
    attachedTab = null;
    refs = {};
  }

  function getRefs() {
    return { ...refs };
  }

  return { execute, attachForSession, reset, getRefs };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { createDriver, M2_EYES, M3_HANDS };
}
