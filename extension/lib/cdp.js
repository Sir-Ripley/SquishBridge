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
// v0.3 share upgrades: read-only tab discovery. Needs no active session —
// it is how the agent learns which tabs exist before the user shares one.
const M6_SHARE = new Set(["list_tabs"]);
// v0.4 full control: navigation, printing, uploads, hover, and page JS.
// `evaluate` exists only because Rodney explicitly approved it (2026-11-09):
// it runs in page context, is audit-logged with its expression, returns by
// value with a size cap, and never gets a user gesture.
const SB_FULL_CONTROL = new Set(["hover", "reload", "back", "forward", "pdf", "upload_file", "evaluate"]);

const SB_EVAL_MAX_EXPRESSION = 20000;
const SB_EVAL_MAX_RESULT = 100000;

// windowsVirtualKeyCode for press_key. Single characters bypass this map
// and travel as keyDown/keyUp with text.
const SB_KEY_CODES = {
  Enter: 13,
  Tab: 9,
  Escape: 27,
  Backspace: 8,
  Delete: 46,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Home: 36,
  End: 35,
  PageUp: 33,
  PageDown: 34,
};

const SB_WAIT_POLL_MS = 500;
const SB_WAIT_DEFAULT_MS = 10000;
const SB_WAIT_MAX_MS = 60000;

function createDriver({ chromeApi, getSession, getAllowlist, getOpenMode, condense, checkUrl }) {
  if (!chromeApi || !chromeApi.debugger || !chromeApi.tabs) throw new Error("driver needs chrome.debugger + chrome.tabs");
  for (const [name, fn] of [["getSession", getSession], ["getAllowlist", getAllowlist], ["condense", condense], ["checkUrl", checkUrl]]) {
    if (typeof fn !== "function") throw new Error(`driver needs a ${name} hook`);
  }
  const openModeOf = typeof getOpenMode === "function" ? getOpenMode : async () => false;

  // Current safety policy: the allowlist plus the open-mode flag threaded
  // into every sbCheckUrl call.
  async function policy() {
    const [list, openMode] = await Promise.all([getAllowlist(), openModeOf()]);
    return { list, opts: { openMode: !!openMode } };
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
    const { list, opts } = await policy();
    const check = checkUrl(tab.url || "", list, opts);
    if (!check.ok) throw new Error("refused: " + check.reason);
    return tab;
  }

  // Resolve a snapshot ref to a live objectId. Backend ids go stale on
  // navigation, so a miss means "take a fresh dom_snapshot", not retry.
  async function resolveRef(tabId, ref) {
    const backendNodeId = refs[ref] != null ? refs[ref] : null;
    if (backendNodeId === null || backendNodeId === undefined) {
      throw new Error(`refused: unknown-ref ${ref} (take a fresh dom_snapshot)`);
    }
    let resolved;
    try {
      resolved = await send(tabId, "DOM.resolveNode", { backendNodeId });
    } catch (err) {
      throw new Error(`refused: stale-ref ${ref} (take a fresh dom_snapshot)`);
    }
    const objectId = resolved && resolved.object && resolved.object.objectId;
    if (!objectId) throw new Error(`refused: stale-ref ${ref} (take a fresh dom_snapshot)`);
    return objectId;
  }

  function quadCenter(quads) {
    const q = quads && quads[0];
    if (!Array.isArray(q) || q.length < 8) throw new Error("error: element has no visible box");
    return {
      x: (q[0] + q[2] + q[4] + q[6]) / 4,
      y: (q[1] + q[3] + q[5] + q[7]) / 4,
    };
  }

  async function snapshotNow(tabId) {
    const tree = await send(tabId, "Accessibility.getFullAXTree", {});
    const condensed = condense(tree && tree.nodes);
    refs = condensed.refs;
    const fresh = await chromeApi.tabs.get(tabId).catch(() => null);
    return {
      url: (fresh && fresh.url) || "",
      title: (fresh && fresh.title) || "",
      nodes: condensed.nodes,
      truncated: condensed.truncated,
    };
  }

  // Tab discovery for the agent: metadata only. Full URLs stay in the
  // browser (paths and query strings can carry tokens); origin + title is
  // enough to ask the user to share a tab. Never attaches the debugger.
  async function listTabsNow() {
    const [session, { list, opts }, tabs] = await Promise.all([
      getSession().catch(() => null),
      policy(),
      chromeApi.tabs.query({}).catch(() => []),
    ]);
    const sharedId = session && Number.isInteger(session.tabId) ? session.tabId : null;
    return {
      tabs: (Array.isArray(tabs) ? tabs : [])
        .filter((t) => t && Number.isInteger(t.id))
        .map((t) => {
          let origin = "";
          try {
            const o = new URL(t.url || "").origin;
            origin = o === "null" ? "" : o;
          } catch {
            origin = "";
          }
          return {
            tabId: t.id,
            title: String(t.title || "").slice(0, 120),
            origin,
            shared: t.id === sharedId,
            drivable: checkUrl(t.url || "", list, opts).ok,
          };
        }),
    };
  }

  async function execute(type, payload) {
    if (!M2_EYES.has(type) && !M3_HANDS.has(type) && !M6_SHARE.has(type) && !SB_FULL_CONTROL.has(type)) {
      throw new Error("unknown-command: " + type);
    }
    if (type === "list_tabs") return listTabsNow();
    const tab = await sharedTab();
    const args = payload && typeof payload === "object" ? payload : {};
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
          const { list, opts } = await policy();
          const check = checkUrl(url, list, opts);
          if (!check.ok) throw new Error("refused: " + check.reason);
          await send(tab.id, "Page.navigate", { url });
          return { url };
        }
        case "screenshot": {
          const shotParams = { format: "png" };
          if (args.fullPage === true) shotParams.captureBeyondViewport = true;
          const shot = await send(tab.id, "Page.captureScreenshot", shotParams);
          if (!shot || typeof shot.data !== "string") throw new Error("error: empty screenshot");
          return { pngBase64: shot.data };
        }
        case "dom_snapshot": {
          return snapshotNow(tab.id);
        }
        case "click": {
          const button = args.button === undefined ? "left" : String(args.button);
          if (!["left", "middle", "right"].includes(button)) {
            throw new Error(`refused: unknown button ${button}`);
          }
          const clickCount = args.clickCount === undefined ? 1 : Number(args.clickCount);
          if (!Number.isInteger(clickCount) || clickCount < 1 || clickCount > 3) {
            throw new Error("refused: clickCount must be 1-3");
          }
          let point;
          if (args.ref !== undefined) {
            const objectId = await resolveRef(tab.id, String(args.ref));
            await send(tab.id, "DOM.scrollIntoViewIfNeeded", { objectId });
            const quads = await send(tab.id, "DOM.getContentQuads", { objectId });
            point = quadCenter(quads && quads.quads);
          } else if (typeof args.x === "number" && typeof args.y === "number") {
            point = { x: args.x, y: args.y };
          } else {
            throw new Error("refused: click needs { ref } or { x, y }");
          }
          for (const mouseType of ["mousePressed", "mouseReleased"]) {
            await send(tab.id, "Input.dispatchMouseEvent", {
              type: mouseType,
              x: point.x,
              y: point.y,
              button,
              clickCount,
            });
          }
          return { clicked: true };
        }
        case "hover": {
          let hoverPoint;
          if (args.ref !== undefined) {
            const objectId = await resolveRef(tab.id, String(args.ref));
            await send(tab.id, "DOM.scrollIntoViewIfNeeded", { objectId });
            const quads = await send(tab.id, "DOM.getContentQuads", { objectId });
            hoverPoint = quadCenter(quads && quads.quads);
          } else if (typeof args.x === "number" && typeof args.y === "number") {
            hoverPoint = { x: args.x, y: args.y };
          } else {
            throw new Error("refused: hover needs { ref } or { x, y }");
          }
          await send(tab.id, "Input.dispatchMouseEvent", {
            type: "mouseMoved",
            x: hoverPoint.x,
            y: hoverPoint.y,
          });
          return { hovered: true };
        }
        case "type":
        case "fill": {
          if (args.ref === undefined) throw new Error(`refused: ${type} needs { ref, text }`);
          if (typeof args.text !== "string") throw new Error(`refused: ${type} needs { ref, text }`);
          const objectId = await resolveRef(tab.id, String(args.ref));
          await send(tab.id, "DOM.focus", { objectId });
          if (type === "fill") {
            // Select-all (Ctrl+A on Windows) so insertText replaces, not appends.
            await send(tab.id, "Input.dispatchKeyEvent", {
              type: "rawKeyDown",
              windowsVirtualKeyCode: 65,
              key: "a",
              modifiers: 2,
            });
            await send(tab.id, "Input.dispatchKeyEvent", { type: "keyUp", key: "a", modifiers: 2 });
          }
          await send(tab.id, "Input.insertText", { text: args.text });
          return { typed: true };
        }
        case "press_key": {
          const key = args.key;
          if (typeof key !== "string" || !key) throw new Error("refused: press_key needs { key }");
          // CDP modifier bitmask: Alt=1, Ctrl=2, Meta=4, Shift=8.
          const modifiers =
            (args.alt === true ? 1 : 0) +
            (args.ctrl === true ? 2 : 0) +
            (args.meta === true ? 4 : 0) +
            (args.shift === true ? 8 : 0);
          if (key.length === 1 && modifiers === 0) {
            await send(tab.id, "Input.dispatchKeyEvent", { type: "keyDown", text: key, key });
            await send(tab.id, "Input.dispatchKeyEvent", { type: "keyUp", key });
          } else if (key.length === 1) {
            // Chord (Ctrl+C and friends): raw events with the virtual key.
            const vkey = key.toUpperCase().charCodeAt(0);
            await send(tab.id, "Input.dispatchKeyEvent", {
              type: "rawKeyDown",
              windowsVirtualKeyCode: vkey,
              key,
              modifiers,
            });
            await send(tab.id, "Input.dispatchKeyEvent", { type: "keyUp", key, modifiers });
          } else if (SB_KEY_CODES[key] !== undefined) {
            await send(tab.id, "Input.dispatchKeyEvent", {
              type: "rawKeyDown",
              windowsVirtualKeyCode: SB_KEY_CODES[key],
              key,
              ...(modifiers ? { modifiers } : {}),
            });
            await send(tab.id, "Input.dispatchKeyEvent", {
              type: "keyUp",
              key,
              ...(modifiers ? { modifiers } : {}),
            });
          } else {
            throw new Error(`refused: unknown key ${key}`);
          }
          return { pressed: true };
        }
        case "scroll": {
          let point;
          if (args.ref !== undefined) {
            const objectId = await resolveRef(tab.id, String(args.ref));
            const quads = await send(tab.id, "DOM.getContentQuads", { objectId });
            point = quadCenter(quads && quads.quads);
          } else {
            const metrics = await send(tab.id, "Page.getLayoutMetrics", {});
            const vp = (metrics && metrics.cssVisualViewport) || {};
            point = { x: vp.pageX || 400, y: vp.pageY || 300 };
          }
          // Canonical names are deltaX/deltaY; dx/dy stay as aliases.
          const rawDX = args.deltaX !== undefined ? args.deltaX : args.dx;
          const rawDY = args.deltaY !== undefined ? args.deltaY : args.dy;
          await send(tab.id, "Input.dispatchMouseEvent", {
            type: "mouseWheel",
            x: point.x,
            y: point.y,
            deltaX: Number(rawDX) || 0,
            deltaY: rawDY === undefined ? 400 : Number(rawDY) || 0,
          });
          return { scrolled: true };
        }
        case "reload": {
          await send(tab.id, "Page.reload", args.ignoreCache === true ? { ignoreCache: true } : {});
          return { reloaded: true };
        }
        case "back":
        case "forward": {
          const hist = await send(tab.id, "Page.getNavigationHistory", {});
          const entries = (hist && hist.entries) || [];
          const idx = hist && Number.isInteger(hist.currentIndex) ? hist.currentIndex : -1;
          const target = type === "back" ? entries[idx - 1] : entries[idx + 1];
          if (!target || target.id === undefined) {
            throw new Error(type === "back" ? "error: no back history" : "error: no forward history");
          }
          // History entries carry their URLs: gate the destination like a
          // navigate, so a walk can never land the tab off-policy.
          const { list: navList, opts: navOpts } = await policy();
          const navCheck = checkUrl(target.url || "", navList, navOpts);
          if (!navCheck.ok) throw new Error("refused: " + navCheck.reason);
          await send(tab.id, "Page.navigateToHistoryEntry", { entryId: target.id });
          return { navigated: true };
        }
        case "pdf": {
          const doc = await send(tab.id, "Page.printToPDF", { printBackground: true });
          if (!doc || typeof doc.data !== "string") throw new Error("error: empty pdf");
          return { pdfBase64: doc.data };
        }
        case "upload_file": {
          // The agent cannot browse the disk: the user names a local file in
          // chat ("upload C:\invoices\q3.pdf"), and the agent sets that path
          // on the form's file input. Chrome reads the file; the page uploads
          // it on submit, exactly as if the user had picked it.
          if (args.ref === undefined || typeof args.path !== "string" || !args.path) {
            throw new Error("refused: upload_file needs { ref, path }");
          }
          const objectId = await resolveRef(tab.id, String(args.ref));
          await send(tab.id, "DOM.setFileInputFiles", { objectId, files: [args.path] });
          const file = String(args.path).split(/[/\\]/).pop() || args.path;
          return { uploaded: true, file };
        }
        case "evaluate": {
          // Page JS with Rodney's explicit approval (2026-11-09). Runs in
          // page context with the page's own privileges — it can read
          // whatever page scripts can (DOM, page storage, non-httpOnly
          // cookies). Guardrails: expression cap, no user gesture,
          // return-by-value with a result cap, and the expression is
          // audit-logged by the background worker on every call.
          const expression = args.expression;
          if (typeof expression !== "string" || !expression.trim()) {
            throw new Error("refused: evaluate needs { expression }");
          }
          if (expression.length > SB_EVAL_MAX_EXPRESSION) {
            throw new Error("refused: expression too large");
          }
          const run = await send(tab.id, "Runtime.evaluate", {
            expression,
            returnByValue: true,
            awaitPromise: args.awaitPromise === true,
          });
          if (run && run.exceptionDetails) {
            const ed = run.exceptionDetails;
            const why =
              (ed.exception && ed.exception.description) || ed.text || "exception";
            throw new Error("error: evaluate threw: " + String(why).slice(0, 500));
          }
          let value = run && run.result ? run.result.value : undefined;
          if (typeof value === "undefined") value = null;
          let size;
          try {
            size = JSON.stringify(value).length;
          } catch {
            throw new Error("error: evaluate result not serializable");
          }
          if (size > SB_EVAL_MAX_RESULT) {
            throw new Error(
              `error: evaluate result too large (${size} chars, cap ${SB_EVAL_MAX_RESULT})`
            );
          }
          return { value };
        }
        case "wait_for": {
          const wantRef = args.ref !== undefined ? String(args.ref) : null;
          const wantText = typeof args.text === "string" && args.text ? args.text.toLowerCase() : null;
          if (!wantRef && !wantText) throw new Error("refused: wait_for needs { ref } or { text }");
          const timeoutMs = Math.min(Math.max(Number(args.timeoutMs) || SB_WAIT_DEFAULT_MS, 1000), SB_WAIT_MAX_MS);
          const deadline = Date.now() + timeoutMs;
          for (;;) {
            const snap = await snapshotNow(tab.id);
            const hit = wantRef
              ? snap.nodes.some((n) => n.ref === wantRef)
              : snap.nodes.some((n) => (n.name || "").toLowerCase().includes(wantText));
            if (hit) return { found: true };
            if (Date.now() >= deadline) throw new Error("wait-timeout");
            await new Promise((r) => setTimeout(r, SB_WAIT_POLL_MS));
          }
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
  module.exports = { createDriver, M2_EYES, M3_HANDS, M6_SHARE, SB_FULL_CONTROL };
}
