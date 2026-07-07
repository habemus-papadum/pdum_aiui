/**
 * The self-contained iPad client page, served by the relay at `GET /`.
 *
 * Deliberately a single HTML string with inline vanilla JS and no build step —
 * the relay serves it verbatim, and it loads on any iPad Safari / Chrome with
 * nothing to bundle. It implements the same small JSON control protocol as
 * `protocol.ts` (kept in sync by hand; the TS module is the contract, this page
 * is one hand-written consumer). Video frames arrive as binary Blobs and drive
 * an `<img>`; pen strokes and finger gestures become normalized intents.
 *
 * Authoring note: this is a TS template literal, so the inline JS avoids
 * backticks and `${` — it uses `+` concatenation and the DOM API instead.
 */
export const IPAD_CLIENT_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<title>aiui paint</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; }
  html, body { margin: 0; height: 100%; overflow: hidden; overscroll-behavior: none; touch-action: none;
    font-family: -apple-system, system-ui, sans-serif; background: #0b0d12; color: #e8ebf0; }
  .screen { position: fixed; inset: 0; display: flex; flex-direction: column; }
  .hidden { display: none !important; }

  /* sessions screen */
  #sessions { padding: 24px; gap: 12px; overflow-y: auto; }
  #sessions h1 { font-size: 22px; margin: 8px 0 2px; }
  #hint { color: #9aa3b2; font-size: 14px; margin: 0 0 8px; }
  #list { display: flex; flex-direction: column; gap: 10px; }
  .card { text-align: left; background: #161a22; border: 1px solid #232838; border-radius: 12px;
    padding: 16px; color: inherit; font: inherit; cursor: pointer; }
  .card:active { background: #1d2230; }
  .card-title { font-size: 17px; font-weight: 600; }
  .card-meta { color: #8b93a4; font-size: 13px; margin-top: 4px; }

  /* stage screen */
  #stageWrap { }
  #stageHeader { display: flex; align-items: center; gap: 12px; padding: 8px 12px;
    background: #0f131a; border-bottom: 1px solid #1c2130; }
  #stageTitle { font-size: 15px; font-weight: 600; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #videoArea { position: relative; flex: 1; background: #000; overflow: hidden; }
  #jpegView, #rtcView { position: absolute; inset: 0; width: 100%; height: 100%;
    object-fit: contain; pointer-events: none; background: #000; }
  #ink { position: absolute; inset: 0; width: 100%; height: 100%; touch-action: none; }

  #toolbar { display: flex; align-items: center; gap: 8px; padding: 8px 12px; flex-wrap: wrap;
    background: #0f131a; border-top: 1px solid #1c2130; }
  button.tool { background: #1a1f2b; border: 1px solid #2a3040; color: #e8ebf0; border-radius: 10px;
    padding: 8px 12px; font: inherit; font-size: 14px; cursor: pointer; }
  button.tool:active { background: #232a3a; }
  #arm.on { background: #ff5c87; border-color: #ff5c87; color: #14060c; font-weight: 700; }
  .swatch { width: 26px; height: 26px; border-radius: 50%; border: 2px solid #2a3040; padding: 0; cursor: pointer; }
  .swatch.sel { border-color: #fff; box-shadow: 0 0 0 2px #0b0d12, 0 0 0 4px #fff; }
  .wbtn { width: 34px; display: flex; align-items: center; justify-content: center; }
  .wbtn.sel { border-color: #fff; }
  .wdot { background: #e8ebf0; border-radius: 50%; }
  .spacer { flex: 1; }
  #status { color: #8b93a4; font-size: 12px; }
</style>
</head>
<body>
  <div id="sessions" class="screen">
    <h1>aiui paint</h1>
    <p id="hint">Connecting...</p>
    <div id="list"></div>
  </div>

  <div id="stageWrap" class="screen hidden">
    <div id="stageHeader">
      <button id="back" class="tool">Back</button>
      <span id="stageTitle">browser</span>
      <span id="status"></span>
    </div>
    <div id="videoArea">
      <img id="jpegView" alt="">
      <video id="rtcView" autoplay playsinline muted></video>
      <canvas id="ink"></canvas>
    </div>
    <div id="toolbar">
      <button id="arm" class="tool">Arm</button>
      <span id="swatches"></span>
      <span id="widths"></span>
    </div>
  </div>

<script>
(function () {
  "use strict";

  function byId(id) { return document.getElementById(id); }

  var proto = location.protocol === "https:" ? "wss://" : "ws://";
  var ws = new WebSocket(proto + location.host + "/client");
  ws.binaryType = "blob";

  var sessionsScreen = byId("sessions");
  var stageScreen = byId("stageWrap");
  var listEl = byId("list");
  var hintEl = byId("hint");
  var jpegView = byId("jpegView");
  var rtcView = byId("rtcView");
  rtcView.muted = true;
  var ink = byId("ink");
  var ictx = ink.getContext("2d");
  var armBtn = byId("arm");
  var titleEl = byId("stageTitle");
  var statusEl = byId("status");

  var PALETTE = ["#ff5c87", "#ffd166", "#06d6a0", "#4cc9f0", "#b5179e", "#ffffff", "#111318"];
  var WIDTHS = [2, 4, 8, 14];

  var state = { armed: false, color: PALETTE[0], width: WIDTHS[1], lastUrl: null, seq: 0 };
  var activePointers = new Map();
  var strokes = [];
  var pinch = { dist: 0, cx: 0, cy: 0 };

  function sendJson(obj) { if (ws.readyState === 1) { ws.send(JSON.stringify(obj)); } }
  function clamp01(n) { return n < 0 ? 0 : (n > 1 ? 1 : n); }
  function dist(a, b) { var dx = a.x - b.x, dy = a.y - b.y; return Math.sqrt(dx * dx + dy * dy); }

  // ── media: JPEG frames (an img) or WebRTC (a video), whichever the host sends ─
  var mediaMode = "none";           // "jpeg" | "webrtc"
  function showJpeg() { mediaMode = "jpeg"; rtcView.classList.add("hidden"); jpegView.classList.remove("hidden"); }
  function showRtc() { mediaMode = "webrtc"; jpegView.classList.add("hidden"); rtcView.classList.remove("hidden"); }
  function mediaSize() {
    if (mediaMode === "webrtc") { return { w: rtcView.videoWidth, h: rtcView.videoHeight }; }
    return { w: jpegView.naturalWidth, h: jpegView.naturalHeight };
  }

  // ── WebRTC receive: the host is the offerer; we answer and show the video ────
  var RTC_CONFIG = { iceServers: [] };
  var pc = null;
  function ensurePc() {
    if (pc) { return pc; }
    pc = new RTCPeerConnection(RTC_CONFIG);
    pc.onicecandidate = function (e) { if (e.candidate) { sendJson({ type: "signal", data: { candidate: e.candidate } }); } };
    pc.ontrack = function (e) {
      rtcView.srcObject = e.streams[0];
      var p = rtcView.play();
      if (p && p.catch) { p.catch(function () {}); }
      showRtc();
    };
    return pc;
  }
  function handleSignal(data) {
    if (!data) { return; }
    if (data.description) {
      var c = ensurePc();
      c.setRemoteDescription(data.description).then(function () {
        if (data.description.type === "offer") {
          return c.createAnswer().then(function (a) { return c.setLocalDescription(a); }).then(function () {
            sendJson({ type: "signal", data: { description: c.localDescription } });
          });
        }
      }).catch(function () {});
    } else if (data.candidate) {
      ensurePc().addIceCandidate(data.candidate).catch(function () {});
    }
  }
  function teardownPc() {
    if (pc) { try { pc.close(); } catch (e) {} pc = null; }
    rtcView.srcObject = null;
    mediaMode = "none";
  }

  // ── websocket ──────────────────────────────────────────────────────────────
  ws.addEventListener("open", function () { hintEl.textContent = "Loading browsers..."; });
  ws.addEventListener("close", function () { hintEl.textContent = "Disconnected from relay."; });
  ws.addEventListener("message", function (ev) {
    if (typeof ev.data === "string") {
      var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      handleControl(m);
      return;
    }
    // A binary JPEG frame (frame-streaming mode).
    var url = URL.createObjectURL(ev.data);
    jpegView.src = url;
    if (mediaMode !== "jpeg") { showJpeg(); }
    if (state.lastUrl) { URL.revokeObjectURL(state.lastUrl); }
    state.lastUrl = url;
  });

  function handleControl(m) {
    if (m.type === "sessions") { renderSessions(m.sessions || []); }
    else if (m.type === "joined") { showStage(m.label || "browser"); }
    else if (m.type === "joinRejected") { hintEl.textContent = "Could not connect: " + (m.reason || "unknown"); }
    else if (m.type === "hostGone") { showSessions(); hintEl.textContent = "The browser disconnected."; }
    else if (m.type === "signal") { handleSignal(m.data); }
    else if (m.type === "viewState") { updateStatus(m); }
  }

  function updateStatus(v) {
    var pct = v.scrollHeight > v.viewportHeight
      ? Math.round((v.scrollY / (v.scrollHeight - v.viewportHeight)) * 100) : 0;
    var mode = mediaMode === "none" ? "connecting" : mediaMode;
    statusEl.textContent = (v.armed ? "armed" : "idle") + "  ·  " + mode + "  ·  scroll " + pct + "%";
  }

  // ── sessions list ────────────────────────────────────────────────────────────
  function renderSessions(sessions) {
    listEl.textContent = "";
    if (!sessions.length) {
      hintEl.textContent = "No browsers connected yet. Start an app that runs a paint host.";
      return;
    }
    hintEl.textContent = "Tap a browser to connect.";
    sessions.forEach(function (s) {
      var card = document.createElement("button");
      card.className = "card";
      var t = document.createElement("div");
      t.className = "card-title";
      t.textContent = s.label || "browser";
      card.appendChild(t);
      var meta = document.createElement("div");
      meta.className = "card-meta";
      var bits = [];
      if (s.project) { bits.push(s.project); }
      if (s.channelTag) { bits.push("session " + s.channelTag); }
      if (s.busy) { bits.push("in use"); }
      meta.textContent = bits.join("   ·   ");
      card.appendChild(meta);
      card.addEventListener("click", function () { sendJson({ type: "join", host: s.id }); });
      listEl.appendChild(card);
    });
  }

  function showStage(label) {
    titleEl.textContent = label;
    teardownPc();                 // fresh media negotiation for this host
    jpegView.removeAttribute("src");
    sessionsScreen.classList.add("hidden");
    stageScreen.classList.remove("hidden");
    setTimeout(resizeInk, 0);
  }
  function showSessions() {
    sendJson({ type: "leave" });
    teardownPc();
    stageScreen.classList.add("hidden");
    sessionsScreen.classList.remove("hidden");
    jpegView.removeAttribute("src");
    strokes = [];
  }
  byId("back").addEventListener("click", showSessions);

  // ── toolbar ──────────────────────────────────────────────────────────────────
  armBtn.addEventListener("click", function () {
    state.armed = !state.armed;
    sendJson({ type: "setArmed", armed: state.armed });
    armBtn.classList.toggle("on", state.armed);
    armBtn.textContent = state.armed ? "Armed" : "Arm";
  });

  var swatchWrap = byId("swatches");
  var swatchEls = [];
  PALETTE.forEach(function (c) {
    var b = document.createElement("button");
    b.className = "tool swatch";
    b.style.background = c;
    b.addEventListener("click", function () {
      state.color = c;
      swatchEls.forEach(function (x) { x.classList.remove("sel"); });
      b.classList.add("sel");
    });
    swatchWrap.appendChild(b);
    swatchEls.push(b);
    if (c === state.color) { b.classList.add("sel"); }
  });

  var widthWrap = byId("widths");
  var widthEls = [];
  WIDTHS.forEach(function (w) {
    var b = document.createElement("button");
    b.className = "tool wbtn";
    var dot = document.createElement("span");
    dot.className = "wdot";
    dot.style.width = Math.max(4, w) + "px";
    dot.style.height = Math.max(4, w) + "px";
    b.appendChild(dot);
    b.addEventListener("click", function () {
      state.width = w;
      widthEls.forEach(function (x) { x.classList.remove("sel"); });
      b.classList.add("sel");
    });
    widthWrap.appendChild(b);
    widthEls.push(b);
    if (w === state.width) { b.classList.add("sel"); }
  });

  // ── coordinate mapping (letterboxed video content rect) ──────────────────────
  function contentRect() {
    var sw = ink.clientWidth, sh = ink.clientHeight;
    var m = mediaSize();
    var nw = m.w, nh = m.h;
    if (!nw || !nh) { return { x: 0, y: 0, w: sw, h: sh }; }
    var scale = Math.min(sw / nw, sh / nh);
    var w = nw * scale, h = nh * scale;
    return { x: (sw - w) / 2, y: (sh - h) / 2, w: w, h: h };
  }
  function toNorm(clientX, clientY) {
    var r = ink.getBoundingClientRect();
    var cr = contentRect();
    var x = clientX - r.left - cr.x;
    var y = clientY - r.top - cr.y;
    return { u: cr.w > 0 ? clamp01(x / cr.w) : 0, v: cr.h > 0 ? clamp01(y / cr.h) : 0 };
  }

  // ── pointer input: pen draws (armed), fingers navigate ───────────────────────
  function isPen(type) { return type === "pen" || type === "mouse"; }
  function pressureOf(e) { return (e.pointerType === "pen" || e.pointerType === "touch") ? e.pressure : undefined; }
  function coalesce(e) {
    if (typeof e.getCoalescedEvents === "function") { var c = e.getCoalescedEvents(); if (c.length) { return c; } }
    return [e];
  }
  function touchPointers() {
    var a = []; activePointers.forEach(function (p) { if (p.type === "touch") { a.push(p); } }); return a;
  }
  function setPinchBaseline() {
    var t = touchPointers();
    if (t.length >= 2) { pinch.dist = dist(t[0], t[1]); pinch.cx = (t[0].x + t[1].x) / 2; pinch.cy = (t[0].y + t[1].y) / 2; }
  }
  function findStroke(id) { for (var i = 0; i < strokes.length; i++) { if (strokes[i].id === id) { return strokes[i]; } } return null; }

  ink.addEventListener("pointerdown", function (e) {
    try { ink.setPointerCapture(e.pointerId); } catch (err) {}
    var p = { x: e.clientX, y: e.clientY, type: e.pointerType, drawId: null };
    activePointers.set(e.pointerId, p);
    if (isPen(e.pointerType) && state.armed) {
      var id = "s" + (++state.seq);
      p.drawId = id;
      var n = toNorm(e.clientX, e.clientY);
      var point = { u: n.u, v: n.v };
      var pr = pressureOf(e);
      if (pr !== undefined) { point.pressure = pr; }
      sendJson({ type: "strokeBegin", id: id, pointerType: e.pointerType === "mouse" ? "mouse" : "pen",
        style: { color: state.color, width: state.width }, point: point });
      strokes.push({ id: id, color: state.color, width: state.width, pts: [{ x: e.clientX, y: e.clientY }], doneAt: null });
    }
    setPinchBaseline();
  });

  ink.addEventListener("pointermove", function (e) {
    var p = activePointers.get(e.pointerId);
    if (!p) { return; }
    var prevX = p.x, prevY = p.y;
    p.x = e.clientX; p.y = e.clientY;

    if (p.drawId) {
      var raw = coalesce(e);
      var out = [];
      var s = findStroke(p.drawId);
      for (var i = 0; i < raw.length; i++) {
        var n = toNorm(raw[i].clientX, raw[i].clientY);
        var np = { u: n.u, v: n.v };
        var pr = pressureOf(raw[i]);
        if (pr !== undefined) { np.pressure = pr; }
        out.push(np);
        if (s) { s.pts.push({ x: raw[i].clientX, y: raw[i].clientY }); }
      }
      sendJson({ type: "strokePoints", id: p.drawId, points: out });
      return;
    }

    var touches = touchPointers();
    if (touches.length === 1) {
      var cr = contentRect();
      sendJson({ type: "scroll",
        du: cr.w > 0 ? -(e.clientX - prevX) / cr.w : 0,
        dv: cr.h > 0 ? -(e.clientY - prevY) / cr.h : 0 });
    } else if (touches.length >= 2) {
      handlePinch();
    }
  });

  function handlePinch() {
    var t = touchPointers();
    if (t.length < 2) { return; }
    var d = dist(t[0], t[1]);
    var cx = (t[0].x + t[1].x) / 2, cy = (t[0].y + t[1].y) / 2;
    if (pinch.dist > 0) {
      var scale = d / pinch.dist;
      var n = toNorm(cx, cy);
      if (Math.abs(scale - 1) > 0.01) { sendJson({ type: "zoom", centerU: n.u, centerV: n.v, scale: scale }); }
      var cr = contentRect();
      var du = cr.w > 0 ? -(cx - pinch.cx) / cr.w : 0;
      var dv = cr.h > 0 ? -(cy - pinch.cy) / cr.h : 0;
      if (du || dv) { sendJson({ type: "scroll", du: du, dv: dv }); }
    }
    pinch.dist = d; pinch.cx = cx; pinch.cy = cy;
  }

  function endPointer(e) {
    var p = activePointers.get(e.pointerId);
    if (!p) { return; }
    activePointers.delete(e.pointerId);
    if (p.drawId) {
      var n = toNorm(e.clientX, e.clientY);
      sendJson({ type: "strokeEnd", id: p.drawId, point: { u: n.u, v: n.v } });
      var s = findStroke(p.drawId);
      if (s) { s.doneAt = performance.now(); }
    }
    setPinchBaseline();
  }
  ink.addEventListener("pointerup", endPointer);
  ink.addEventListener("pointercancel", endPointer);

  // ── predictive ink (fades once the authoritative frame catches up) ───────────
  var FADE_MS = 500;
  function resizeInk() {
    var dpr = window.devicePixelRatio || 1;
    ink.width = Math.round(ink.clientWidth * dpr);
    ink.height = Math.round(ink.clientHeight * dpr);
  }
  window.addEventListener("resize", resizeInk);

  function drawInk() {
    if (ictx) {
      var dpr = window.devicePixelRatio || 1;
      ictx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ictx.clearRect(0, 0, ink.width, ink.height);
      var r = ink.getBoundingClientRect();
      var now = performance.now();
      var alive = [];
      for (var i = 0; i < strokes.length; i++) {
        var s = strokes[i];
        var alpha = 1;
        if (s.doneAt) {
          alpha = Math.max(0, 1 - (now - s.doneAt) / FADE_MS);
          if (alpha <= 0) { continue; }
        }
        drawOne(s, alpha, r);
        alive.push(s);
      }
      strokes = alive;
    }
    requestAnimationFrame(drawInk);
  }
  function drawOne(s, alpha, r) {
    if (!s.pts.length) { return; }
    ictx.save();
    ictx.globalAlpha = alpha;
    ictx.strokeStyle = s.color;
    ictx.fillStyle = s.color;
    ictx.lineWidth = s.width;
    ictx.lineCap = "round";
    ictx.lineJoin = "round";
    if (s.pts.length === 1) {
      ictx.beginPath();
      ictx.arc(s.pts[0].x - r.left, s.pts[0].y - r.top, Math.max(1, s.width / 2), 0, Math.PI * 2);
      ictx.fill();
    } else {
      ictx.beginPath();
      ictx.moveTo(s.pts[0].x - r.left, s.pts[0].y - r.top);
      for (var i = 1; i < s.pts.length; i++) { ictx.lineTo(s.pts[i].x - r.left, s.pts[i].y - r.top); }
      ictx.stroke();
    }
    ictx.restore();
  }
  requestAnimationFrame(drawInk);
})();
</script>
</body>
</html>`;
