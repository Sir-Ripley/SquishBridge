"use strict";

/* Squish Bridge — on-page indicator (M0).
 * While a session is active the extension injects this script into the
 * shared tab via chrome.scripting (M4 wiring). It draws a persistent
 * border + banner so control is never invisible, and offers a STOP button
 * that asks the background worker to end the session immediately.
 */

(function () {
  const BANNER_ID = "squish-bridge-banner";
  if (document.getElementById(BANNER_ID)) return;

  const banner = document.createElement("div");
  banner.id = BANNER_ID;
  banner.setAttribute("role", "alert");
  banner.innerHTML =
    '<span><strong>Squish is driving this tab.</strong> ' +
    "Only this tab is shared. Click STOP in the extension to end control.</span>";

  const stop = document.createElement("button");
  stop.type = "button";
  stop.textContent = "STOP";
  stop.addEventListener("click", () => {
    try {
      chrome.runtime.sendMessage({ type: "stop-session", reason: "on-page stop" });
    } catch {
      /* background unreachable: session teardown runs there on reconnect */
    }
  });
  banner.appendChild(stop);

  Object.assign(banner.style, {
    position: "fixed",
    top: "0",
    left: "0",
    right: "0",
    zIndex: "2147483647",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "12px",
    padding: "8px 16px",
    fontFamily: "system-ui, sans-serif",
    fontSize: "14px",
    color: "#1a1a1a",
    background: "#ffd60a",
    borderBottom: "3px solid #1a1a1a",
  });
  Object.assign(stop.style, {
    fontWeight: "700",
    padding: "4px 16px",
    cursor: "pointer",
    border: "2px solid #1a1a1a",
    borderRadius: "6px",
    background: "#fff",
  });

  document.documentElement.appendChild(banner);
  document.documentElement.style.setProperty(
    "--squish-bridge-outline",
    "3px solid #ffd60a"
  );
})();
