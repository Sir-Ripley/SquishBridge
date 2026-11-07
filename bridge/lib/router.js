"use strict";

/* Squish Bridge — command router (M2).
 * Matches bridge→extension commands with extension→bridge results by id.
 * Transport-agnostic: `send` pushes a message at the socket; results come
 * back through handleResult. Timeouts and dead sockets reject loudly —
 * a command never hangs silently.
 */

function createRouter({ send, defaultTimeoutMs = 30000, now = Date.now, later = setTimeout, clear = clearTimeout } = {}) {
  if (typeof send !== "function") throw new Error("router needs a send function");
  const pending = new Map(); // id -> { resolve, reject, timer }
  let seq = 0;

  function nextId() {
    seq += 1;
    return `cmd-${now()}-${seq}`;
  }

  function sendCommand(type, payload, { timeoutMs = defaultTimeoutMs, id = nextId() } = {}) {
    if (typeof type !== "string" || !type) throw new Error("command type must be a string");
    const message = { id, type, payload: payload === undefined ? {} : payload };
    return new Promise((resolve, reject) => {
      const timer = later(() => {
        pending.delete(id);
        const err = new Error("command timed out");
        err.code = "timeout";
        reject(err);
      }, Math.min(Math.max(Number(timeoutMs) || defaultTimeoutMs, 1000), 120000));
      // Unref in Node so a pending command never holds the process open.
      if (timer && typeof timer.unref === "function") timer.unref();
      pending.set(id, { resolve, reject, timer });
      try {
        send(message);
      } catch (err) {
        clear(timer);
        pending.delete(id);
        reject(err);
      }
    });
  }

  // Returns true when the message completed a pending command.
  function handleResult(msg) {
    if (!msg || typeof msg.id !== "string" || typeof msg.ok !== "boolean") return false;
    const p = pending.get(msg.id);
    if (!p) return false;
    clear(p.timer);
    pending.delete(msg.id);
    p.resolve(msg);
    return true;
  }

  function failAll(err) {
    const list = [...pending.values()];
    pending.clear();
    for (const p of list) {
      try {
        clear(p.timer);
      } catch {
        /* ignore */
      }
      p.reject(err);
    }
  }

  function pendingCount() {
    return pending.size;
  }

  return { sendCommand, handleResult, failAll, pendingCount };
}

module.exports = { createRouter };
