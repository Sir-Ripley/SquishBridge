"use strict";

/* Squish Bridge — audit log helper (M0).
 * Extension-side ring buffer persisted in chrome.storage.local.
 * Every command and its outcome is recorded; there are no silent actions.
 * Plain script, no modules. Node-compatible export guard for tests.
 */

const SB_AUDIT_MAX_ENTRIES = 500;

function sbAuditEntry(command, targetOrigin, status, detail) {
  return {
    ts: new Date().toISOString(),
    command: String(command || "unknown"),
    targetOrigin: String(targetOrigin || ""),
    status: String(status || "unknown"),
    detail: detail === undefined ? "" : String(detail).slice(0, 500),
  };
}

function sbAuditAppend(log, entry) {
  const next = Array.isArray(log) ? log.slice() : [];
  next.push(entry);
  while (next.length > SB_AUDIT_MAX_ENTRIES) next.shift();
  return next;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { SB_AUDIT_MAX_ENTRIES, sbAuditEntry, sbAuditAppend };
}
