"use strict";

/* Squish Bridge — append-only audit log (M0 real).
 * One JSON object per line: {ts, method, path, status, origin, detail}.
 * No page content is logged beyond what a command explicitly returned
 * (M2+ detail strings are already length-capped by callers).
 */

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_LOG_FILE = path.join(__dirname, "..", "audit.log.jsonl");
const MAX_DETAIL = 500;

function entry(method, urlPath, status, origin, detail) {
  return {
    ts: new Date().toISOString(),
    method: String(method || ""),
    path: String(urlPath || ""),
    status: Number(status) || 0,
    origin: String(origin || ""),
    detail: String(detail === undefined ? "" : detail).slice(0, MAX_DETAIL),
  };
}

function append(logFile, record) {
  const file = logFile || DEFAULT_LOG_FILE;
  fs.appendFileSync(file, JSON.stringify(record) + "\n", "utf8");
  return record;
}

function readTail(logFile, limit) {
  const file = logFile || DEFAULT_LOG_FILE;
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return [];
    throw err;
  }
  const lines = text.split("\n").filter((l) => l.trim().length);
  return lines
    .slice(Math.max(0, lines.length - (limit || 100)))
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

module.exports = { DEFAULT_LOG_FILE, MAX_DETAIL, entry, append, readTail };
