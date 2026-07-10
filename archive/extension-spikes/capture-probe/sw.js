// capture-probe service worker: tab lifecycle logging, invocation tracking,
// getMediaStreamId in all its variants, captureVisibleTab, desktopCapture.
// All results flow to the side panel as {to:"panel", kind:"log"|...} messages.

/** tabId -> ISO time of last action click (the activeTab-style invocation). */
const invocations = new Map();

function log(text, extra) {
  const msg = { to: "panel", kind: "log", at: new Date().toISOString(), text, extra };
  chrome.runtime.sendMessage(msg).catch(() => {});
  console.log("[capture-probe]", text, extra ?? "");
}

chrome.action.onClicked.addListener((tab) => {
  invocations.set(tab.id, new Date().toISOString());
  log(`INVOKED on tab ${tab.id} (${tab.url}) — activeTab granted`, {
    tabId: tab.id,
    windowId: tab.windowId,
  });
  // Gesture context: allowed to open the panel here.
  chrome.sidePanel.open({ windowId: tab.windowId }).catch((e) => log(`sidePanel.open failed: ${e.message}`));
});

// ── tab lifecycle → panel log (M2 split view detection, M4 continuity) ──────
chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  let info = {};
  try {
    const t = await chrome.tabs.get(tabId);
    info = { url: t.url, splitViewId: t.splitViewId };
  } catch {}
  log(`tabs.onActivated tab=${tabId} win=${windowId}`, info);
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if ("splitViewId" in changeInfo) {
    log(`tabs.onUpdated tab=${tabId} splitViewId -> ${changeInfo.splitViewId}`);
  }
});
chrome.tabs.onRemoved.addListener((tabId) => log(`tabs.onRemoved tab=${tabId}`));

// ── offscreen document management ────────────────────────────────────────────
async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (contexts.length > 0) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["USER_MEDIA"],
    justification: "consume tabCapture stream IDs for the capture measurement spike",
  });
  log("offscreen document created");
}

// ── command handling from the panel ──────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.to !== "sw") return false;
  (async () => {
    try {
      switch (msg.cmd) {
        case "invocations": {
          sendResponse({ ok: true, invocations: Object.fromEntries(invocations) });
          return;
        }
        case "listTabs": {
          const tabs = await chrome.tabs.query({});
          sendResponse({
            ok: true,
            tabs: tabs.map((t) => ({
              id: t.id,
              windowId: t.windowId,
              active: t.active,
              splitViewId: t.splitViewId,
              title: (t.title ?? "").slice(0, 60),
              url: (t.url ?? "").slice(0, 80),
            })),
            splitViewIdNone: chrome.tabs.SPLIT_VIEW_ID_NONE,
          });
          return;
        }
        case "capture": {
          // M4a/M4b: getMediaStreamId for a target tab, consumed in the
          // offscreen document. Works without invocation? For a background tab?
          const targetTabId = msg.targetTabId;
          const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId });
          log(`getMediaStreamId ok for tab ${targetTabId} (invoked at: ${invocations.get(targetTabId) ?? "NEVER"})`);
          await ensureOffscreen();
          await chrome.runtime.sendMessage({
            to: "offscreen",
            cmd: "consume",
            streamId,
            kind: "tab",
            label: `tab ${targetTabId}`,
          });
          sendResponse({ ok: true });
          return;
        }
        case "captureInPage": {
          // M1 holy grail: mint the stream id for consumption BY THE CAPTURED
          // TAB ITSELF, so CropTarget/RestrictionTarget minting and cropTo/
          // restrictTo happen in one context — no transport problem.
          const t = msg.tabId;
          const streamId = await chrome.tabCapture.getMediaStreamId({
            targetTabId: t,
            consumerTabId: t,
          });
          log(`getMediaStreamId(consumerTabId=${t}) ok — handing to content script`);
          const res = await chrome.tabs.sendMessage(t, { cmd: "consumeInPage", streamId });
          sendResponse({ ok: true, res });
          return;
        }
        case "visibleTab": {
          // M2: what does captureVisibleTab show for a split-view window?
          const dataUrl = await chrome.tabs.captureVisibleTab(msg.windowId, {
            format: "jpeg",
            quality: 70,
          });
          const active = (await chrome.tabs.query({ active: true, windowId: msg.windowId }))[0];
          chrome.runtime.sendMessage({
            to: "panel",
            kind: "snapshot",
            label: `captureVisibleTab win=${msg.windowId} activeTab=${active?.id} splitViewId=${active?.splitViewId}`,
            dataUrl,
          });
          sendResponse({ ok: true });
          return;
        }
        case "capturedTabs": {
          const tabs = await chrome.tabCapture.getCapturedTabs();
          sendResponse({ ok: true, tabs });
          return;
        }
        case "desktopCapture": {
          // Picker appears (that's the measurement). Consumed in offscreen.
          chrome.desktopCapture.chooseDesktopMedia(msg.sources ?? ["window", "screen"], (streamId, opts) => {
            if (!streamId) {
              log("desktopCapture: cancelled/empty streamId");
              sendResponse({ ok: false, error: "cancelled" });
              return;
            }
            log(`desktopCapture streamId ok (options: ${JSON.stringify(opts ?? {})})`);
            ensureOffscreen()
              .then(() =>
                chrome.runtime.sendMessage({
                  to: "offscreen",
                  cmd: "consume",
                  streamId,
                  kind: "desktop",
                  label: "desktopCapture pick",
                }),
              )
              .then(() => sendResponse({ ok: true }))
              .catch((e) => sendResponse({ ok: false, error: e.message }));
          });
          return; // async sendResponse via callback above
        }
        default:
          sendResponse({ ok: false, error: `unknown cmd ${msg.cmd}` });
      }
    } catch (e) {
      log(`sw ${msg.cmd} FAILED: ${e.name ?? ""} ${e.message}`);
      sendResponse({ ok: false, error: `${e.name ?? "Error"}: ${e.message}` });
    }
  })();
  return true; // keep sendResponse alive for the async work
});
