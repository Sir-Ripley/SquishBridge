"use strict";

/* Squish Bridge — background service worker (M0 scaffold).
 * Owns: pairing state, allowlist, session state, audit log, bridge socket.
 * M0: local state machine + safety gate + audit + STOP are real.
 * M1 (pairing/WS) and M2 (CDP driver) arrive behind the clearly-marked
 * NOT-IMPLEMENTED stubs below. The scaffolding compiles and loads now.
 */

importScripts("lib/safety.js", "lib/audit.js");

const SB_STORE = {
  TOKEN: "sb.pairing",
  ALLOWLIST: "sb.allowlist",
  SESSION: "sb.session",
  AUDIT: "sb.audit",
  BRIDGE_URL: "sb.bridgeUrl",
};

const SB_KEEPALIVE_ALARM = "sb-keepalive";
const SB_VERSION = "0.1.0";

let mem = {
  socket: null, // M1: WebSocket to the bridge.
  socketState: "disconnected", // disconnected | connecting | connected
  session: { active: false, tabId: null, startedAt: null },
};

async function sbStoreGet(keys) {
  return chrome.storage.local.get(keys);
}

async function sbStoreSet(obj) {
  return chrome.storage.local.set(obj);
}

async function sbGetAllowlist() {
  const got = await sbStoreGet([SB_STORE.ALLOWLIST]);
  const list = got[SB_STORE.ALLOWLIST];
  if (Array.isArray(list) && list.length) return list.map(String);
  return [...SB_INITIAL_ALLOWLIST];
}

async function sbGetSession() {
  const got = await sbStoreGet([SB_STORE.SESSION]);
  const s = got[SB_STORE.SESSION];
  if (s && typeof s === "object") {
    mem.session = {
      active: !!s.active,
      tabId: Number.isInteger(s.tabId) ? s.tabId : null,
      startedAt: s.startedAt || null,
    };
  }
  return mem.session;
}

async function sbSetSession(patch) {
  mem.session = { ...mem.session, ...patch };
  await sbStoreSet({ [SB_STORE.SESSION]: mem.session });
  return mem.session;
}

async function sbGetAudit() {
  const got = await sbStoreGet([SB_STORE.AUDIT]);
  const log = got[SB_STORE.AUDIT];
  return Array.isArray(log) ? log : [];
}

async function sbAudit(command, targetOrigin, status, detail) {
  const log = sbAuditAppend(await sbGetAudit(), sbAuditEntry(command, targetOrigin, status, detail));
  await sbStoreSet({ [SB_STORE.AUDIT]: log });
  return log;
}

// ---- Session control (real in M0) ----

async function sbStartSession(tabId) {
  if (!Number.isInteger(tabId)) throw new Error("set a shared tab first");
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) throw new Error("shared tab no longer exists");
  const check = sbCheckUrl(tab.url || "", await sbGetAllowlist());
  if (!check.ok) {
    await sbAudit("start-session", tab.url || "", "refused", check.reason);
    throw new Error("refused: " + check.reason);
  }
  await sbSetSession({ active: true, tabId, startedAt: new Date().toISOString() });
  await sbAudit("start-session", new URL(tab.url).origin, "ok", "tab " + tabId);
  // M2: chrome.debugger.attach + banner inject happen here.
  // M4: banner injection via chrome.scripting goes here.
  return mem.session;
}

async function sbStopSession(reason) {
  const was = await sbGetSession();
  try {
    if (Number.isInteger(was.tabId)) {
      await chrome.debugger.detach({ tabId: was.tabId }).catch(() => {});
    }
  } finally {
    await sbSetSession({ active: false, tabId: null, startedAt: null });
    await sbAudit("stop-session", "", "ok", reason || "user stop");
  }
  // M4: remove banner here.
  return mem.session;
}

// ---- Bridge socket (M1 stub) ----

function sbConnectBridge() {
  // M1 implements: read token + bridge URL, WSS connect with backoff,
  // authenticate, route {id,type,payload} commands, return results.
  mem.socketState = "disconnected";
  return Promise.resolve({ ok: false, notImplemented: "M1-pairing" });
}

// ---- Popup message API ----

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    const type = msg && msg.type;
    switch (type) {
      case "get-status": {
        const [allowlist, session, audit] = await Promise.all([
          sbGetAllowlist(),
          sbGetSession(),
          sbGetAudit(),
        ]);
        sendResponse({
          ok: true,
          version: SB_VERSION,
          socketState: mem.socketState,
          session,
          allowlist,
          auditTail: audit.slice(-50),
          pairing: { paired: false, milestone: "M1-pairing" },
        });
        break;
      }
      case "set-tab": {
        if (!Number.isInteger(msg.tabId)) throw new Error("tabId must be an integer");
        await sbSetSession({ active: false, tabId: msg.tabId, startedAt: null });
        await sbAudit("set-tab", "", "ok", "tab " + msg.tabId);
        sendResponse({ ok: true, session: mem.session });
        break;
      }
      case "start-session": {
        const session = await sbGetSession();
        sendResponse({ ok: true, session: await sbStartSession(session.tabId) });
        break;
      }
      case "stop-session": {
        sendResponse({ ok: true, session: await sbStopSession(msg.reason || "popup stop") });
        break;
      }
      case "allowlist-add": {
        const host = sbNormalizeHost(msg.origin || "");
        if (!host) throw new Error("enter a valid https origin or hostname");
        if (sbIsDenied("https://" + host + "/")) throw new Error("refused: denylisted origin");
        const list = await sbGetAllowlist();
        if (!sbIsAllowlisted(host, list)) list.push(host);
        await sbStoreSet({ [SB_STORE.ALLOWLIST]: list });
        await sbAudit("allowlist-add", host, "ok", "");
        sendResponse({ ok: true, allowlist: list });
        break;
      }
      case "allowlist-remove": {
        const host = sbNormalizeHost(msg.origin || "");
        const list = (await sbGetAllowlist()).filter((h) => sbNormalizeHost(h) !== host);
        await sbStoreSet({ [SB_STORE.ALLOWLIST]: list });
        await sbAudit("allowlist-remove", host, "ok", "");
        sendResponse({ ok: true, allowlist: list });
        break;
      }
      case "get-audit": {
        sendResponse({ ok: true, audit: await sbGetAudit() });
        break;
      }
      case "clear-audit": {
        await sbStoreSet({ [SB_STORE.AUDIT]: [] });
        sendResponse({ ok: true, audit: [] });
        break;
      }
      case "pair":
      case "unpair":
      case "connect-bridge": {
        await sbAudit(msg.type, "", "refused", "M1-pairing not implemented yet");
        sendResponse({ ok: false, error: "pairing arrives in M1 — see build plan" });
        break;
      }
      default:
        sendResponse({ ok: false, error: "unknown message type: " + type });
    }
  })().catch((err) => {
    sendResponse({ ok: false, error: String((err && err.message) || err) });
  });
  return true; // async response
});

// ---- Hard STOP: keyboard shortcut + tab closed + debugger detached ----

chrome.commands.onCommand.addListener(async (command) => {
  if (command === "stop-session") {
    await sbStopSession("keyboard shortcut");
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const session = await sbGetSession();
  if (session.active && session.tabId === tabId) {
    await sbStopSession("shared tab closed");
  }
});

chrome.debugger.onDetach.addListener(async (source, reason) => {
  const session = await sbGetSession();
  if (session.active && source && source.tabId === session.tabId) {
    await sbStopSession("debugger detached (" + reason + ")");
  }
});

// ---- MV3 keepalive ----

chrome.runtime.onInstalled.addListener(async () => {
  const got = await sbStoreGet([SB_STORE.ALLOWLIST]);
  if (!Array.isArray(got[SB_STORE.ALLOWLIST])) {
    await sbStoreSet({ [SB_STORE.ALLOWLIST]: [...SB_INITIAL_ALLOWLIST] });
  }
  chrome.alarms.create(SB_KEEPALIVE_ALARM, { periodInMinutes: 1 });
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm && alarm.name === SB_KEEPALIVE_ALARM) {
    await sbGetSession(); // rehydrate; M1 also probes the socket here.
  }
});
