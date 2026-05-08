/**
 * Hermes Browser Bridge — popup logic.
 *
 * The popup intentionally avoids being the source of truth: it asks the
 * background worker for status, and additionally listens for push
 * notifications so its UI stays in lockstep with the toolbar badge instead
 * of lagging it by up to a poll interval.
 */

const $ = (id) => document.getElementById(id);

const statusDot     = $("statusDot");
const statusText    = $("statusText");
const btnConnect    = $("btnConnect");
const btnDisconnect = $("btnDisconnect");
const btnShow       = $("btnShow");
const btnRefresh    = $("btnRefresh");
const infoBridge    = $("infoBridge");
const infoWindow    = $("infoWindow");
const infoUrl       = $("infoUrl");

// The info row values are clipped to a single line; mirror the value into
// `title` so the user can hover to see the full string when truncated.
function setInfo(el, value) {
  el.textContent = value;
  el.title = value && value !== "—" ? value : "";
}

// Three real states drive the entire UI: "disconnected" / "connecting" /
// "connected". The background worker is the single source of truth — we
// just render whatever `state` it reports.
function renderState(resp) {
  const state = (resp && resp.state) || "disconnected";

  statusDot.classList.remove("connected", "connecting");
  if (state === "connected") {
    statusDot.classList.add("connected");
    statusText.textContent = "Connected to bridge";
  } else if (state === "connecting") {
    statusDot.classList.add("connecting");
    statusText.textContent = "Connecting…";
  } else {
    statusText.textContent = "Disconnected";
  }

  // Treat "connecting" as already-online from the user's perspective so the
  // Connect button doesn't reappear and let them double-trigger.
  const online = state !== "disconnected";
  btnConnect.classList.toggle("hidden", online);
  btnDisconnect.classList.toggle("hidden", !online);

  if (resp && resp.agentAlive) {
    setInfo(infoWindow, `#${resp.agentWindowId} (tab ${resp.agentTabId})`);
    setInfo(infoUrl, resp.url || "about:blank");
    btnShow.disabled = false;
  } else {
    setInfo(infoWindow, "—");
    setInfo(infoUrl, "—");
    btnShow.disabled = state !== "connected";
  }
}

async function refreshStatus() {
  let resp = null;
  try {
    resp = await chrome.runtime.sendMessage({ action: "status" });
  } catch {
    resp = null;
  }
  renderState(resp || {});
}

btnConnect.addEventListener("click", async () => {
  // Optimistic UI: paint connecting state immediately so the popup tracks
  // the badge instead of lagging behind it.
  renderState({ state: "connecting" });
  await chrome.runtime.sendMessage({ action: "connect" });
  refreshStatus();
});

btnDisconnect.addEventListener("click", async () => {
  renderState({ state: "disconnected" });
  await chrome.runtime.sendMessage({ action: "disconnect" });
  refreshStatus();
});

btnShow.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ action: "show" });
  refreshStatus();
});

btnRefresh.addEventListener("click", refreshStatus);

// Push channel: background broadcasts whenever the WS state flips. This
// removes the polling-induced lag between the badge and the popup UI.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "hermes:status-changed") {
    refreshStatus();
  }
});

// Polling acts only as a slow fallback — push notifications drive the UI
// the rest of the time.
let pollTimer = null;

document.addEventListener("DOMContentLoaded", () => {
  refreshStatus();
  pollTimer = setInterval(refreshStatus, 1500);
});

window.addEventListener("unload", () => {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
});
