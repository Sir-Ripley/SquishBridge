"use strict";

/* Squish Bridge — DOM snapshot condensing (M2).
 * Turns a raw Accessibility.getFullAXTree dump into a small, numbered
 * outline the agent can target semantically. Refs ("1", "2", …) are
 * positional: each snapshot rebuilds the ref table, and M3 resolves a ref
 * through the backendDOMNodeId captured here. Pure functions — no chrome.*
 * here, so this file loads in the service worker AND under node for tests.
 */

const SB_SNAPSHOT_LIMIT = 300;

// Roles worth driving or reading. Everything else is skipped unless it
// carries a name (headings, named regions) — raw StaticText floods the
// snapshot and drowns the interactive elements.
const SB_AX_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "checkbox",
  "radio",
  "combobox",
  "listbox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "switch",
  "slider",
  "heading",
  "image",
]);

// CDP wraps strings as { value } objects; be liberal and accept both.
function sbAxText(field) {
  if (typeof field === "string") return field;
  if (field && typeof field.value === "string") return field.value;
  return "";
}

function sbAxName(node) {
  return sbAxText(node && node.name);
}

function sbAxValue(node) {
  return sbAxText(node && node.value);
}

function sbAxRole(node) {
  return sbAxText(node && node.role) || "unknown";
}

function sbAxInteresting(node) {
  if (!node || node.ignored) return false;
  const role = sbAxRole(node);
  if (SB_AX_ROLES.has(role)) return true;
  return sbAxName(node).length > 0 && (role === "StaticText" || role === "heading" || role === "label");
}

// Returns { nodes: [{ref, role, name, value}], refs: {ref: backendNodeId|null},
// truncated }. Refs restart at "1" for every snapshot.
function sbCondenseAXTree(axNodes, { limit = SB_SNAPSHOT_LIMIT } = {}) {
  const nodes = [];
  const refs = {};
  let n = 0;
  let truncated = false;
  for (const node of Array.isArray(axNodes) ? axNodes : []) {
    if (!sbAxInteresting(node)) continue;
    n += 1;
    if (n > limit) {
      truncated = true;
      break;
    }
    const ref = String(n);
    const backendNodeId =
      Number.isInteger(node.backendDOMNodeId) && node.backendDOMNodeId > 0
        ? node.backendDOMNodeId
        : null;
    refs[ref] = backendNodeId;
    const entry = { ref, role: sbAxRole(node) };
    const name = sbAxName(node).slice(0, 200);
    if (name) entry.name = name;
    const value = sbAxValue(node).slice(0, 200);
    if (value) entry.value = value;
    nodes.push(entry);
  }
  return { nodes, refs, truncated };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { SB_SNAPSHOT_LIMIT, SB_AX_ROLES, sbCondenseAXTree };
}
