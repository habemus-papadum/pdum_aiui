// capture-probe offscreen document: consumes stream IDs (tab or desktop),
// reports what kind of track came back (M1: does cropTo/restrictTo exist on a
// tabCapture-derived track?), snapshots frames (M2 evidence), holds multiple
// streams at once (M4c concurrency), and probes error shapes for cross-context
// crop/restriction targets.

const streams = new Map(); // id -> { stream, video, label }
let nextId = 1;

function log(text, extra) {
  chrome.runtime.sendMessage({
    to: "panel",
    kind: "log",
    at: new Date().toISOString(),
    text: `[offscreen] ${text}`,
    extra,
  }).catch(() => {});
}

async function snapshot(id) {
  const entry = streams.get(id);
  if (!entry) return log(`snapshot: no stream #${id}`);
  const v = entry.video;
  const scale = Math.min(1, 800 / (v.videoWidth || 800));
  const canvas = new OffscreenCanvas(
    Math.max(1, Math.round(v.videoWidth * scale)),
    Math.max(1, Math.round(v.videoHeight * scale)),
  );
  canvas.getContext("2d").drawImage(v, 0, 0, canvas.width, canvas.height);
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.7 });
  const dataUrl = await new Promise((res) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.readAsDataURL(blob);
  });
  const s = entry.stream.getVideoTracks()[0]?.getSettings() ?? {};
  chrome.runtime.sendMessage({
    to: "panel",
    kind: "snapshot",
    label: `#${id} ${entry.label} — video ${v.videoWidth}x${v.videoHeight}, settings ${s.width}x${s.height}@${s.frameRate ?? "?"}fps`,
    dataUrl,
  });
}

function reportTrack(id, track, label) {
  const report = {
    id,
    label,
    trackConstructor: track.constructor?.name,
    trackLabel: track.label,
    settings: track.getSettings(),
    hasCropTo: typeof track.cropTo,
    hasRestrictTo: typeof track.restrictTo,
    globalCropTarget: typeof globalThis.CropTarget,
    globalRestrictionTarget: typeof globalThis.RestrictionTarget,
  };
  log(`track report for #${id}`, report);
  return report;
}

async function consume(streamId, kind, label) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { mandatory: { chromeMediaSource: kind, chromeMediaSourceId: streamId } },
  });
  const id = nextId++;
  const video = document.createElement("video");
  video.srcObject = stream;
  video.muted = true;
  await video.play();
  streams.set(id, { stream, video, label });
  const track = stream.getVideoTracks()[0];
  track.addEventListener("ended", () => {
    log(`stream #${id} (${label}) ENDED by browser/user`);
    streams.delete(id);
  });
  reportTrack(id, track, label);
  setTimeout(() => snapshot(id), 700);
  return id;
}

// M1 error-shape probe: mint targets from OFFSCREEN's own DOM (which is not the
// captured surface) and see exactly how cropTo/restrictTo fail on this track.
async function tryLocalTargets(id) {
  const entry = streams.get(id);
  if (!entry) return { error: `no stream #${id}` };
  const track = entry.stream.getVideoTracks()[0];
  const el = document.createElement("div");
  el.style.cssText = "width:100px;height:50px;isolation:isolate;background:#fff";
  document.body.append(el);
  const out = {};
  if (typeof globalThis.CropTarget?.fromElement === "function" && typeof track.cropTo === "function") {
    try {
      const t = await CropTarget.fromElement(el);
      await track.cropTo(t);
      out.cropTo = "RESOLVED (unexpected — offscreen element on a tab track)";
    } catch (e) {
      out.cropTo = `rejected: ${e.name}: ${e.message}`;
    }
  } else {
    out.cropTo = "API missing in offscreen";
  }
  if (typeof globalThis.RestrictionTarget?.fromElement === "function" && typeof track.restrictTo === "function") {
    try {
      const t = await RestrictionTarget.fromElement(el);
      await track.restrictTo(t);
      out.restrictTo = "RESOLVED (unexpected)";
    } catch (e) {
      out.restrictTo = `rejected: ${e.name}: ${e.message}`;
    }
  } else {
    out.restrictTo = "API missing in offscreen";
  }
  el.remove();
  log(`local-target probe on #${id}`, out);
  return out;
}

// Deferred-list bonus probe: getDisplayMedia from an offscreen document (no
// possible user gesture). Expect NotAllowedError; record whatever happens.
async function tryGdm() {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
    log("offscreen getDisplayMedia RESOLVED (unexpected)", stream.getVideoTracks()[0]?.getSettings());
    for (const t of stream.getTracks()) t.stop();
    return { resolved: true };
  } catch (e) {
    log(`offscreen getDisplayMedia rejected: ${e.name}: ${e.message}`);
    return { error: `${e.name}: ${e.message}` };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.to !== "offscreen") return false;
  (async () => {
    try {
      switch (msg.cmd) {
        case "consume": {
          const id = await consume(msg.streamId, msg.kind, msg.label);
          sendResponse({ ok: true, id });
          return;
        }
        case "snapshot": {
          await snapshot(msg.id);
          sendResponse({ ok: true });
          return;
        }
        case "snapshotAll": {
          for (const id of streams.keys()) await snapshot(id);
          sendResponse({ ok: true, count: streams.size });
          return;
        }
        case "tryLocalTargets": {
          sendResponse({ ok: true, result: await tryLocalTargets(msg.id) });
          return;
        }
        case "gdm": {
          sendResponse({ ok: true, result: await tryGdm() });
          return;
        }
        case "stopAll": {
          for (const [id, e] of streams) {
            for (const t of e.stream.getTracks()) t.stop();
            log(`stopped #${id} (${e.label})`);
          }
          streams.clear();
          sendResponse({ ok: true });
          return;
        }
        default:
          sendResponse({ ok: false, error: `unknown cmd ${msg.cmd}` });
      }
    } catch (e) {
      log(`offscreen ${msg.cmd} FAILED: ${e.name}: ${e.message}`);
      sendResponse({ ok: false, error: `${e.name}: ${e.message}` });
    }
  })();
  return true;
});
