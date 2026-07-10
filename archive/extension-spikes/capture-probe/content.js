// capture-probe content script (classic script — no imports; see the devtools
// extension's tab-identity.md for why that matters). Two jobs:
//
//  1. M1 "holy grail" leg: consume a getMediaStreamId(consumerTabId=this tab)
//     stream *in the captured tab itself*, then mint CropTarget /
//     RestrictionTarget from local elements and apply cropTo/restrictTo on the
//     SAME context — no cross-context transport at all.
//  2. M1 transport leg: demonstrate what happens when a CropTarget tries to
//     ride chrome.runtime messaging (expected: lost/serialization error).
//
// Also answers pageInfo (viewport dims) for the M2 split-view comparisons.

function cpLog(text, extra) {
  chrome.runtime.sendMessage({
    to: "panel",
    kind: "log",
    at: new Date().toISOString(),
    text: "[page " + location.host + "] " + text,
    extra: extra,
  }).catch(function () {});
}

function snapshotVideo(video, label) {
  var scale = Math.min(1, 800 / (video.videoWidth || 800));
  var canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
  var dataUrl = canvas.toDataURL("image/jpeg", 0.7);
  chrome.runtime.sendMessage({ to: "panel", kind: "snapshot", label: label, dataUrl: dataUrl }).catch(function () {});
}

var held = null; // { stream, video } — kept so repeated probes can reuse it

function consumeInPage(streamId) {
  return navigator.mediaDevices
    .getUserMedia({
      audio: false,
      video: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
    })
    .then(function (stream) {
      var video = document.createElement("video");
      video.srcObject = stream;
      video.muted = true;
      held = { stream: stream, video: video };
      return video.play().then(function () {
        var track = stream.getVideoTracks()[0];
        var report = {
          trackConstructor: track.constructor && track.constructor.name,
          settings: track.getSettings(),
          hasCropTo: typeof track.cropTo,
          hasRestrictTo: typeof track.restrictTo,
          globalCropTarget: typeof window.CropTarget,
          globalRestrictionTarget: typeof window.RestrictionTarget,
          pageInner: window.innerWidth + "x" + window.innerHeight,
          dpr: window.devicePixelRatio,
        };
        cpLog("in-page consumption OK", report);

        // Give the stream a beat, snapshot the unrestricted view first.
        return new Promise(function (res) { setTimeout(res, 700); }).then(function () {
          snapshotVideo(video, "in-page tab capture, unrestricted (" + location.host + ")");

          // A visible, isolated probe element for restriction/crop targets.
          var el = document.createElement("div");
          el.id = "capture-probe-target";
          el.style.cssText =
            "position:fixed;left:24px;top:24px;width:320px;height:160px;z-index:2147483646;" +
            "isolation:isolate;background:#123;color:#8ef;font:14px monospace;padding:12px;" +
            "border:2px solid #8ef;border-radius:8px";
          el.textContent = "capture-probe target element — restrictTo should show ONLY this box";
          document.body.appendChild(el);

          var out = { report: report };
          var p = Promise.resolve();

          if (typeof window.CropTarget !== "undefined" && typeof track.cropTo === "function") {
            p = p
              .then(function () { return CropTarget.fromElement(el); })
              .then(function (t) { return track.cropTo(t); })
              .then(function () {
                out.cropTo = "RESOLVED";
                return new Promise(function (res) { setTimeout(res, 500); });
              })
              .then(function () {
                out.cropSettings = track.getSettings();
                snapshotVideo(video, "after cropTo(probe element) — expect just the box region");
                // undo the crop for the restrict leg
                return track.cropTo(null).catch(function () {});
              })
              .catch(function (e) { out.cropTo = "rejected: " + e.name + ": " + e.message; });
          } else {
            out.cropTo = "API missing in page/isolated world";
          }

          if (typeof window.RestrictionTarget !== "undefined" && typeof track.restrictTo === "function") {
            p = p
              .then(function () { return RestrictionTarget.fromElement(el); })
              .then(function (t) { return track.restrictTo(t); })
              .then(function () {
                out.restrictTo = "RESOLVED";
                return new Promise(function (res) { setTimeout(res, 500); });
              })
              .then(function () {
                out.restrictSettings = track.getSettings();
                snapshotVideo(video, "after restrictTo(probe element) — expect ONLY the box, occluders gone");
                return track.restrictTo(null).catch(function () {});
              })
              .catch(function (e) { out.restrictTo = "rejected: " + e.name + ": " + e.message; });
          } else {
            out.restrictTo = "API missing in page/isolated world";
          }

          return p.then(function () {
            setTimeout(function () { el.remove(); }, 3000);
            cpLog("M1 in-page probe complete", out);
            return out;
          });
        });
      });
    });
}

chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
  if (!msg || !msg.cmd) return false;
  if (msg.cmd === "consumeInPage") {
    consumeInPage(msg.streamId)
      .then(function (out) { sendResponse({ ok: true, out: out }); })
      .catch(function (e) {
        cpLog("in-page consumption FAILED: " + e.name + ": " + e.message);
        sendResponse({ ok: false, error: e.name + ": " + e.message });
      });
    return true;
  }
  if (msg.cmd === "pageInfo") {
    sendResponse({
      ok: true,
      url: location.href,
      inner: window.innerWidth + "x" + window.innerHeight,
      dpr: window.devicePixelRatio,
      visibility: document.visibilityState,
    });
    return false;
  }
  if (msg.cmd === "mintTransport") {
    // M1 transport leg: what survives chrome.runtime messaging?
    if (typeof window.CropTarget === "undefined") {
      sendResponse({ ok: false, error: "CropTarget API missing" });
      return false;
    }
    CropTarget.fromElement(document.body)
      .then(function (t) {
        var probe = { viaJson: null, direct: t };
        try {
          probe.viaJson = JSON.stringify(t);
        } catch (e) {
          probe.viaJson = "JSON.stringify threw: " + e.name;
        }
        // sendResponse serializes with the extension messaging codec; whatever
        // arrives on the panel side is the answer.
        sendResponse({ ok: true, probe: probe, note: "check what 'direct' deserialized to" });
      })
      .catch(function (e) { sendResponse({ ok: false, error: e.name + ": " + e.message }); });
    return true;
  }
  if (msg.cmd === "stopInPage") {
    if (held) {
      held.stream.getTracks().forEach(function (t) { t.stop(); });
      held = null;
      cpLog("in-page stream stopped");
    }
    sendResponse({ ok: true });
    return false;
  }
  return false;
});
