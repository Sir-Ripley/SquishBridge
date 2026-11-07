"use strict";

/* Squish Bridge — background service worker (M1).
 * Owns: pairing state, allowlist, session state, audit log, bridge socket.
 * Real in M1: pair/unpair, token issue exchange over the socket, WSS
 * connect + exponential-backoff reconnect, heartbeat watchdog via alarms.
 * M2 adds: the CDP driver and command routing over the live socket.
 */

importScripts("lib/safety.js", "lib/audit.js", "lib/link.js");

const SB_STORE = {
  TOKEN: "sb.pairing", // { token, installId, bridgeUrl, pairedAt } | null
  INSTALL_ID: "sb.installId", // stable per browser profile; survives unpair
  ALLOWLIST: "sb.allowlist",
  SESSION: "sb.session",
  AUDIT: "sb.audit",
};

const SB_KEEPALIVE_ALARM = "sb-keepalive";
const SB_VERSION = "0.1.0";
const SB_PAIR_TIMEOUT_MS = 20000;

let mem = {
  socket: null,
  socketState: "disconnected", // disconnected | connecting | connected
  wantConnection: false, // true while paired: a dropped socket must come back
  backoffAttempt: 0,
  reconnectTimer: null,
};

function sbUuid() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

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
    mem._session = {
      active: !!s.active,
      tabId: Number.isInteger(s.tabId) ? s.tabId : null,
      startedAt: s.startedAt || null,
    };
  } else {
    mem._session = mem._session || { active: false, tabId: null, startedAt: null };
  }
  return mem._session;
}

async function sbSetSession(patch) {
  const cur = await sbGetSession();
  const next = { ...cur, ...patch };
  await sbStoreSet({ [SB_STORE.SESSION]: next });
  mem._session = next;
  return next;
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

// ---- Pairing (real in M1) ----

async function sbGetInstallId() {
  const got = await sbStoreGet([SB_STORE.INSTALL_ID]);
  let id = got[SB_STORE.INSTALL_ID];
  if (typeof id !== "string" || !/^[A-Za-z0-9-]{8,64}$/.test(id)) {
    id = "ext-" + sbUuid();
    await sbStoreSet({ [SB_STORE.INSTALL_ID]: id });
  }
  return id;
}

async function sbGetPairing() {
  const got = await sbStoreGet([SB_STORE.TOKEN]);
  const p = got[SB_STORE.TOKEN];
  if (p && typeof p === "object" && typeof p.token === "string" && p.token) return p;
  return null;
}

function sbAdoptSocket(ws, pairing) {
  sbDropSocket();
  mem.socket = ws;
  mem.socketState = "connected";
  mem.wantConnection = true;
  mem.backoffAttempt = 0;
  ws.onclose = (ev) => sbOnSocketClose(ev, pairing);
  ws.onerror = () => {
    sbAudit("socket", "", "error", "socket error").catch(() => {});
  };
  ws.onmessage = (ev) => sbOnSocketMessage(ev, pairing);
}

function sbDropSocket() {
  if (mem.reconnectTimer) {
    clearTimeout(mem.reconnectTimer);
    mem.reconnectTimer = null;
  }
  const ws = mem.socket;
  mem.socket = null;
  if (ws) {
    ws.onclose = null;
    ws.onerror = null;
    ws.onmessage = null;
    try {
      ws.close(1000, "replaced");
    } catch {
      /* already gone */
    }
  }
}

async function sbOnSocketMessage(ev, pairing) {
  let msg = null;
  try {
    msg = JSON.parse(ev.data);
  } catch {
    return;
  }
  // M2 routes bridge commands here. M1 logs anything unexpected.
  if (msg && msg.type && msg.type !== "auth") {
    await sbAudit("bridge-msg", "", "ignored", String(msg.type).slice(0, 100));
  }
}

async function sbOnSocketClose(ev, pairing) {
  mem.socket = null;
  mem.socketState = "disconnected";
  const code = ev && ev.code;
  if (code === 4401 || code === 4403) {
    // Token dead (rejected or revoked): stop wanting the connection and
    // clear the token. The installId survives, so re-pairing is one step.
    mem.wantConnection = false;
    await sbStoreSet({ [SB_STORE.TOKEN]: null });
    await sbAudit("socket", "", "unpaired", code === 4403 ? "device revoked" : "token rejected");
    return;
  }
  await sbAudit("socket", "", "dropped", "code " + code);
  if (mem.wantConnection) sbScheduleReconnect(pairing);
}

function sbScheduleReconnect(pairing) {
  if (!pairing || mem.reconnectTimer || mem.socket) return;
  const delay = sbBackoffDelay(mem.backoffAttempt);
  mem.backoffAttempt += 1;
  mem.reconnectTimer = setTimeout(() => {
    mem.reconnectTimer = null;
    sbConnectSocket(pairing).catch(() => {});
  }, delay);
}

function sbConnectSocket(pairing) {
  return new Promise((resolve) => {
    if (mem.socket) return resolve(true);
    mem.socketState = "connecting";
    let ws;
    try {
      ws = new WebSocket(sbSocketUrl(pairing.bridgeUrl));
    } catch (err) {
      mem.socketState = "disconnected";
      sbScheduleReconnect(pairing);
      return resolve(false);
    }
    const authTimer = setTimeout(() => {
      try {
        ws.close(4408, "auth timeout");
      } catch {
        /* ignore */
      }
    }, SB_PAIR_TIMEOUT_MS);
    ws.onopen = () => {
      ws.send(JSON.stringify(sbAuthMessage(sbUuid(), pairing.token, pairing.installId)));
    };
    ws.onmessage = async (ev) => {
      let msg = null;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (!sbIsAuthOk(msg)) {
        // Auth refused: the bridge will close with 4401; let onclose handle it.
        return;
      }
      clearTimeout(authTimer);
      sbAdoptSocket(ws, pairing);
      await sbAudit("socket", "", "connected", "reconnected");
      resolve(true);
    };
    ws.onclose = (ev) => {
      clearTimeout(authTimer);
      mem.socketState = "disconnected";
      sbOnSocketClose(ev, pairing).catch(() => {});
      resolve(false);
    };
    ws.onerror = () => {
      // onclose follows; nothing to do here.
    };
  });
}

// Pair: open a socket, trade the one-time code for a device token on that
// same socket (no fetch, so no host permission is needed), then adopt the
// socket as the live connection.
async function sbPair(bridgeUrl, code) {
  const normalized = sbNormalizeBridgeUrl(bridgeUrl);
  const cleanCode = String(code || "").trim();
  if (!cleanCode) throw new Error("enter the pairing code from chat");
  const installId = await sbGetInstallId();
  sbDropSocket();
  mem.wantConnection = false;
  mem.socketState = "connecting";

  const ws = await new Promise((resolve, reject) => {
    let sock;
    try {
      sock = new WebSocket(normalized + SB_WS_PATH);
    } catch (err) {
      reject(new Error("cannot reach bridge: " + err.message));
      return;
    }
    const timer = setTimeout(() => {
      try {
        sock.close();
      } catch {
        /* ignore */
      }
      reject(new Error("bridge did not answer in time"));
    }, SB_PAIR_TIMEOUT_MS);
    sock.onopen = () => {
      sock.send(JSON.stringify({ id: sbUuid(), type: "pair", payload: { code: cleanCode, installId } }));
    };
    sock.onmessage = (ev) => {
      let msg = null;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      clearTimeout(timer);
      if (msg && msg.ok === true && msg.result && msg.result.token) {
        resolve({ sock, token: msg.result.token });
      } else {
        try {
          sock.close();
        } catch {
          /* ignore */
        }
        reject(new Error("pairing refused: " + ((msg && msg.error) || "unknown")));
      }
    };
    sock.onerror = () => {
      clearTimeout(timer);
      reject(new Error("cannot reach bridge at " + normalized));
    };
  });

  const pairing = { token: ws.token, installId, bridgeUrl: normalized, pairedAt: new Date().toISOString() };
  await sbStoreSet({ [SB_STORE.TOKEN]: pairing });
  // Authenticate on the same socket and adopt it.
  await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), SB_PAIR_TIMEOUT_MS);
    ws.sock.onmessage = (ev) => {
      let msg = null;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (sbIsAuthOk(msg)) {
        clearTimeout(timer);
        resolve(true);
      }
    };
    ws.sock.onerror = () => {};
    ws.sock.onclose = () => {
      clearTimeout(timer);
      resolve(false);
    };
    ws.sock.send(JSON.stringify(sbAuthMessage(sbUuid(), pairing.token, pairing.installId)));
  }).then(async (authed) => {
    if (authed) {
      sbAdoptSocket(ws.sock, pairing);
      await sbAudit("pair", normalized, "ok", installId);
    } else {
      try {
        ws.sock.close();
      } catch {
        /* ignore */
      }
      mem.socketState = "disconnected";
      await sbAudit("pair", normalized, "auth-failed", installId);
      throw new Error("bridge accepted the code but auth did not complete");
    }
  });
  return pairing;
}

async function sbUnpair(reason) {
  mem.wantConnection = false;
  sbDropSocket();
  mem.socketState = "disconnected";
  mem.backoffAttempt = 0;
  await sbStoreSet({ [SB_STORE.TOKEN]: null });
  await sbAudit("unpair", "", "ok", reason || "user unpair");
}

async function sbEnsureConnection() {
  const pairing = await sbGetPairing();
  if (!pairing) {
    mem.wantConnection = false;
    mem.socketState = "disconnected";
    return false;
  }
  mem.wantConnection = true;
  if (mem.socket && mem.socket.readyState === WebSocket.OPEN) {
    mem.socketState = "connected";
    return true;
  }
  if (mem.socket) return true; // handshake in flight
  return sbConnectSocket(pairing);
}

// ---- Session control (M0, unchanged semantics) ----

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
  return mem._session;
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
  return mem._session;
}

// ---- Popup message API ----

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    const type = msg && msg.type;
    switch (type) {
      case "get-status": {
        const [allowlist, session, auditLog, pairing, installId] = await Promise.all([
          sbGetAllowlist(),
          sbGetSession(),
          sbGetAudit(),
          sbGetPairing(),
          sbGetInstallId(),
        ]);
        sendResponse({
          ok: true,
          version: SB_VERSION,
          socketState: mem.socketState,
          session,
          allowlist,
          auditTail: auditLog.slice(-50),
          pairing: pairing
            ? { paired: true, installId: pairing.installId, bridgeUrl: pairing.bridgeUrl }
            : { paired: false, installId, bridgeUrl: "" },
        });
        break;
      }
      case "set-tab": {
        if (!Number.isInteger(msg.tabId)) throw new Error("tabId must be an integer");
        await sbSetSession({ active: false, tabId: msg.tabId, startedAt: null });
        await sbAudit("set-tab", "", "ok", "tab " + msg.tabId);
        sendResponse({ ok: true, session: mem._session });
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
      case "pair": {
        const pairing = await sbPair(msg.bridgeUrl, msg.code);
        sendResponse({
          ok: true,
          pairing: { paired: true, installId: pairing.installId, bridgeUrl: pairing.bridgeUrl },
          socketState: mem.socketState,
        });
        break;
      }
      case "unpair": {
        await sbUnpair(msg.reason || "popup unpair");
        sendResponse({ ok: true, socketState: mem.socketState });
        break;
      }
      case "connect-bridge": {
        const ok = await sbEnsureConnection();
        sendResponse({ ok, socketState: mem.socketState });
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

// ---- Hard STOP ----

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

// ---- MV3 keepalive + socket watchdog ----

chrome.runtime.onInstalled.addListener(async () => {
  const got = await sbStoreGet([SB_STORE.ALLOWLIST]);
  if (!Array.isArray(got[SB_STORE.ALLOWLIST])) {
    await sbStoreSet({ [SB_STORE.ALLOWLIST]: [...SB_INITIAL_ALLOWLIST] });
  }
  chrome.alarms.create(SB_KEEPALIVE_ALARM, { periodInMinutes: 1 });
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm && alarm.name === SB_KEEPALIVE_ALARM) {
    await sbGetSession(); // rehydrate
    const pairing = await sbGetPairing();
    if (pairing && !mem.socket) sbEnsureConnection().catch(() => {});
  }
});

chrome.runtime.onStartup.addListener(() => {
  sbEnsureConnection().catch(() => {});
});

// Connect on worker load if already paired (covers install/update restarts).
sbEnsureConnection().catch(() => {});
