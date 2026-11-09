"use strict";

/* Squish Bridge — popup UI (M0 skeleton). Talks to background.js only. */

const $ = (id) => document.getElementById(id);

function send(type, extra) {
  return chrome.runtime.sendMessage({ type, ...(extra || {}) });
}

function showError(err) {
  $("error").textContent = err ? String((err && err.message) || err) : "";
}

function renderStatus(s) {
  $("version").textContent = "v" + (s.version || "?");
  const sess = s.session || {};
  const paired = !!(s.pairing && s.pairing.paired);
  const open = s.openMode === true ? " · Open Mode" : "";
  $("status").textContent = sess.active
    ? `Active — driving tab ${sess.tabId}${open}`
    : paired
      ? `Paired — bridge ${s.socketState || "disconnected"}${open}`
      : "Not paired.";
  $("openMode").checked = s.openMode === true;
  $("sessionInfo").textContent = sess.active
    ? `Sharing tab ${sess.tabId} since ${sess.startedAt || "?"}. Banner is shown on the page.`
    : sess.tabId != null
      ? `Shared tab: ${sess.tabId} (not started).`
      : "No shared tab selected.";
  $("start").disabled = sess.active || sess.tabId == null;
  $("stop").disabled = !sess.active;
  const p = s.pairing || {};
  $("pairInfo").textContent = paired
    ? `Paired as ${p.installId} to ${p.bridgeUrl}.`
    : `This browser: ${p.installId || "?"}. Not paired.`;
  if (p.bridgeUrl && !$("bridgeUrl").value) $("bridgeUrl").value = p.bridgeUrl;
  $("pair").disabled = paired;
  $("unpair").disabled = !paired;
}

function renderAllowlist(list) {
  const ul = $("allowlist");
  ul.innerHTML = "";
  for (const host of list || []) {
    const li = document.createElement("li");
    li.textContent = host;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "Remove";
    btn.addEventListener("click", async () => {
      try {
        showError("");
        const res = await send("allowlist-remove", { origin: host });
        if (!res.ok) throw new Error(res.error);
        renderAllowlist(res.allowlist);
      } catch (err) {
        showError(err);
      }
    });
    li.appendChild(btn);
    ul.appendChild(li);
  }
}

function renderAudit(entries) {
  const ol = $("audit");
  ol.innerHTML = "";
  for (const e of (entries || []).slice(-50).reverse()) {
    const li = document.createElement("li");
    li.textContent = `${e.ts || "?"} · ${e.command} · ${e.targetOrigin || "-"} · ${e.status}${e.detail ? " · " + e.detail : ""}`;
    ol.appendChild(li);
  }
}

async function refresh() {
  try {
    showError("");
    const s = await send("get-status");
    if (!s.ok) throw new Error(s.error);
    renderStatus(s);
    renderAllowlist(s.allowlist);
    renderAudit(s.auditTail);
  } catch (err) {
    showError(err);
  }
}

$("shareSite").addEventListener("click", async () => {
  try {
    showError("");
    const res = await send("share-site", {});
    if (!res.ok) throw new Error(res.error);
    await refresh();
  } catch (err) {
    showError(err);
  }
});

$("openMode").addEventListener("change", async () => {
  try {
    showError("");
    const res = await send("set-open-mode", { open: $("openMode").checked });
    if (!res.ok) throw new Error(res.error);
    await refresh();
  } catch (err) {
    showError(err);
  }
});

$("useCurrentTab").addEventListener("click", async () => {
  try {
    showError("");
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) throw new Error("no active tab");
    const res = await send("set-tab", { tabId: tab.id });
    if (!res.ok) throw new Error(res.error);
    await refresh();
  } catch (err) {
    showError(err);
  }
});

$("start").addEventListener("click", async () => {
  try {
    showError("");
    const res = await send("start-session");
    if (!res.ok) throw new Error(res.error);
    await refresh();
  } catch (err) {
    showError(err);
  }
});

$("stop").addEventListener("click", async () => {
  try {
    showError("");
    const res = await send("stop-session", { reason: "popup stop" });
    if (!res.ok) throw new Error(res.error);
    await refresh();
  } catch (err) {
    showError(err);
  }
});

$("addOrigin").addEventListener("click", async () => {
  try {
    showError("");
    const origin = $("newOrigin").value.trim();
    const res = await send("allowlist-add", { origin });
    if (!res.ok) throw new Error(res.error);
    $("newOrigin").value = "";
    renderAllowlist(res.allowlist);
  } catch (err) {
    showError(err);
  }
});

$("refreshAudit").addEventListener("click", async () => {
  try {
    showError("");
    const res = await send("get-audit");
    if (!res.ok) throw new Error(res.error);
    renderAudit(res.audit);
  } catch (err) {
    showError(err);
  }
});

$("downloadAudit").addEventListener("click", async () => {
  try {
    showError("");
    const res = await send("get-audit");
    if (!res.ok) throw new Error(res.error);
    const blob = new Blob([JSON.stringify(res.audit, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "squish-bridge-audit.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  } catch (err) {
    showError(err);
  }
});

$("clearAudit").addEventListener("click", async () => {
  try {
    showError("");
    const res = await send("clear-audit");
    if (!res.ok) throw new Error(res.error);
    renderAudit(res.audit);
  } catch (err) {
    showError(err);
  }
});

$("pair").addEventListener("click", async () => {
  try {
    showError("");
    $("pair").disabled = true;
    const res = await send("pair", { bridgeUrl: $("bridgeUrl").value, code: $("pairCode").value });
    if (!res.ok) throw new Error(res.error);
    $("pairCode").value = "";
    await refresh();
  } catch (err) {
    showError(err);
  } finally {
    await refresh().catch(() => {});
  }
});

$("unpair").addEventListener("click", async () => {
  try {
    showError("");
    const res = await send("unpair", { reason: "popup unpair" });
    if (!res.ok) throw new Error(res.error);
    await refresh();
  } catch (err) {
    showError(err);
  }
});

document.addEventListener("DOMContentLoaded", refresh);
