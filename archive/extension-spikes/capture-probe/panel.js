// capture-probe side panel: the operator console + the M6 lifetime probe.

const logEl = document.getElementById("log");
const shotsEl = document.getElementById("shots");
const tabSelect = document.getElementById("tabSelect");
const panelBorn = new Date().toISOString();

function line(text, extra) {
  const div = document.createElement("div");
  div.textContent = `${new Date().toISOString().slice(11, 19)} ${text}`;
  if (extra !== undefined) div.textContent += ` ${JSON.stringify(extra)}`;
  logEl.prepend(div);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.to !== "panel") return;
  if (msg.kind === "log") line(msg.text, msg.extra);
  if (msg.kind === "snapshot") {
    const fig = document.createElement("figure");
    fig.style.margin = "0";
    const cap = document.createElement("figcaption");
    cap.textContent = `${new Date().toISOString().slice(11, 19)} ${msg.label}`;
    const img = document.createElement("img");
    img.src = msg.dataUrl;
    img.title = msg.label;
    fig.append(cap, img);
    shotsEl.prepend(fig);
    line(`snapshot: ${msg.label}`);
  }
});

async function sw(cmd, extra = {}) {
  try {
    const res = await chrome.runtime.sendMessage({ to: "sw", cmd, ...extra });
    if (!res?.ok) line(`${cmd} -> FAILED`, res);
    return res;
  } catch (e) {
    line(`${cmd} -> threw ${e.message}`);
    return { ok: false, error: e.message };
  }
}
async function off(cmd, extra = {}) {
  try {
    const res = await chrome.runtime.sendMessage({ to: "offscreen", cmd, ...extra });
    if (!res?.ok) line(`offscreen ${cmd} -> FAILED`, res);
    return res;
  } catch (e) {
    line(`offscreen ${cmd} -> threw ${e.message} (no offscreen doc yet? capture something first)`);
    return { ok: false, error: e.message };
  }
}

function selectedTabId() {
  const v = Number(tabSelect.value);
  return Number.isInteger(v) && v >= 0 ? v : undefined;
}

async function refreshTabs() {
  const res = await sw("listTabs");
  if (!res?.ok) return;
  tabSelect.innerHTML = "";
  for (const t of res.tabs) {
    const opt = document.createElement("option");
    opt.value = String(t.id);
    const split = t.splitViewId !== undefined && t.splitViewId !== res.splitViewIdNone ? ` [split ${t.splitViewId}]` : "";
    opt.textContent = `${t.id}${t.active ? " *" : ""}${split} ${t.title || t.url}`;
    tabSelect.append(opt);
  }
  const splits = res.tabs.filter((t) => t.splitViewId !== undefined && t.splitViewId !== res.splitViewIdNone);
  document.getElementById("splitNote").textContent =
    res.tabs[0]?.splitViewId === undefined
      ? "NOTE: Tab.splitViewId is undefined in this Chrome — split view API not present"
      : splits.length
        ? `split view tabs: ${splits.map((t) => `${t.id}(view ${t.splitViewId})`).join(", ")}`
        : "no tabs in split view right now";
  line(`tabs refreshed (${res.tabs.length})`);
}

document.getElementById("refreshTabs").onclick = refreshTabs;
document.getElementById("invocations").onclick = async () => line("invocations", (await sw("invocations"))?.invocations);
document.getElementById("captureSel").onclick = () => sw("capture", { targetTabId: selectedTabId() });
document.getElementById("captureInPage").onclick = async () => {
  const res = await sw("captureInPage", { tabId: selectedTabId() });
  if (res?.ok) line("captureInPage result", res.res);
};
document.getElementById("mintTransport").onclick = async () => {
  try {
    const res = await chrome.tabs.sendMessage(selectedTabId(), { cmd: "mintTransport" });
    line("mintTransport response (what did 'direct' become?)", res);
  } catch (e) {
    line(`mintTransport threw: ${e.message}`);
  }
};
document.getElementById("capturedTabs").onclick = async () => line("capturedTabs", (await sw("capturedTabs"))?.tabs);
document.getElementById("snapshotAll").onclick = () => off("snapshotAll");
document.getElementById("tryLocal").onclick = async () => {
  // probe every held stream
  const res = await off("tryLocalTargets", { id: 1 });
  if (res?.ok) line("offscreen local-target probe (#1)", res.result);
};
document.getElementById("stopAll").onclick = async () => {
  await off("stopAll");
  const t = selectedTabId();
  if (t !== undefined) chrome.tabs.sendMessage(t, { cmd: "stopInPage" }).catch(() => {});
};
document.getElementById("visibleTab").onclick = async () => {
  const win = await chrome.windows.getCurrent();
  sw("visibleTab", { windowId: win.id });
};
document.getElementById("gdmPanel").onclick = async () => {
  // getDisplayMedia from an extension page with a real click = transient activation.
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
    const track = stream.getVideoTracks()[0];
    line("panel getDisplayMedia OK", {
      constructor: track.constructor?.name,
      settings: track.getSettings(),
      hasCropTo: typeof track.cropTo,
      hasRestrictTo: typeof track.restrictTo,
    });
    const video = document.createElement("video");
    video.srcObject = stream;
    video.muted = true;
    await video.play();
    setTimeout(() => {
      const scale = Math.min(1, 800 / (video.videoWidth || 800));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
      const fig = document.createElement("figure");
      fig.style.margin = "0";
      const cap = document.createElement("figcaption");
      cap.textContent = `panel gDM ${video.videoWidth}x${video.videoHeight} (surface: ${track.getSettings().displaySurface})`;
      const img = document.createElement("img");
      img.src = canvas.toDataURL("image/jpeg", 0.7);
      fig.append(cap, img);
      shotsEl.prepend(fig);
      for (const t of stream.getTracks()) t.stop();
      line("panel gDM snapshot taken, stream stopped");
    }, 700);
  } catch (e) {
    line(`panel getDisplayMedia rejected: ${e.name}: ${e.message}`);
  }
};
document.getElementById("gdmOffscreen").onclick = async () => {
  const res = await off("gdm");
  if (res?.ok) line("offscreen gDM probe", res.result);
};
document.getElementById("desktopCapture").onclick = () => sw("desktopCapture", { sources: ["window", "screen", "tab"] });
document.getElementById("clearLog").onclick = () => {
  logEl.innerHTML = "";
  shotsEl.innerHTML = "";
};

// ── M6: heartbeat to storage.session; gaps = throttle/discard evidence ───────
const BEAT_MS = 20_000;
async function beat() {
  const now = Date.now();
  const { m6 } = await chrome.storage.session.get("m6");
  const state = m6 ?? { born: panelBorn, lastBeat: now, gaps: [] };
  if (now - state.lastBeat > BEAT_MS * 1.75) {
    state.gaps.push({ from: new Date(state.lastBeat).toISOString(), gapMs: now - state.lastBeat });
  }
  state.lastBeat = now;
  await chrome.storage.session.set({ m6: state });
}
setInterval(beat, BEAT_MS);
beat();
document.getElementById("lifetime").onclick = async () => {
  const { m6 } = await chrome.storage.session.get("m6");
  line("M6 lifetime report (this document born " + panelBorn + ")", m6);
};

refreshTabs();
line("panel ready");
