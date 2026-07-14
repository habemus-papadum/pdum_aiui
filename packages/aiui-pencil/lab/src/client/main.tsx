/**
 * main.tsx — the remote pencil client: the served iPad app, and the C2 rig.
 *
 * The transport is the library's `ClientSession` (this file is its reference
 * consumer); the command bar is `aiui-remote-bar`'s client over ITS own socket
 * (D5: two channels, one page). What lives HERE is what genuinely belongs to
 * the app:
 *
 *   the plane      the video's CONTENT box (letterboxing!), tracked from the
 *                  video element's own resize events — WebRTC ramps resolution
 *                  from a tiny first frame, and a plane computed from anything
 *                  else silently keeps its stale default (measured: strokes
 *                  y-compressed by exactly the letterbox ratio)
 *   the preview    a real `PencilSurface`, `localInput: false`, dissolving on
 *                  the D3 crossfade — sized adaptively from the connection's
 *                  measured delays when stats are available
 *   the pen rules  pencil-mode latch, palm rejection, two-finger navigation —
 *                  ported from the paint client, which earned them on a real
 *                  iPad
 */

import {
  ClientSession,
  clientRelayUrl,
  fadeWindowMs,
  type LinkStats,
  type PencilMode,
  PencilSurface,
  penSample,
  resolveParams,
  type SessionInfo,
  type Tool,
} from "@habemus-papadum/aiui-pencil";
import {
  createRemoteBarClient,
  REMOTE_BAR_STYLES,
  RemoteBar,
} from "@habemus-papadum/aiui-remote-bar";
import type { JSX } from "@solidjs/web";
import { render } from "@solidjs/web";
import { createSignal, For, Show } from "solid-js";

// ── connection state, as signals (discrete events — no throttling needed) ────

const [phase, setPhase] = createSignal<"connecting" | "picking" | "viewing" | "lost">("connecting");
const [sessions, setSessions] = createSignal<SessionInfo[]>([]);
const [videoUp, setVideoUp] = createSignal(false);
const [videoNote, setVideoNote] = createSignal("waiting for video…");
const [tool, setTool] = createSignal<Tool>("draw");
const [mode, setMode] = createSignal<PencilMode>("write");
/** Latches on the first pen event: after this, only the pencil inks (palms and
 * fingers navigate). The old paint client's rule, ported. */
const [penMode, setPenMode] = createSignal(false);

let stage: HTMLDivElement | undefined;
let video: HTMLVideoElement | undefined;
let plane: HTMLDivElement | undefined;
let preview: PencilSurface | undefined;

// ── the pencil plane (D2): the video's CONTENT box, not the stage ────────────

let planeBox = { left: 0, top: 0, width: 1, height: 1 };

function recomputePlane(): void {
  if (!stage || !video || !plane) {
    return;
  }
  const sw = stage.clientWidth;
  const sh = stage.clientHeight;
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (vw > 0 && vh > 0) {
    const scale = Math.min(sw / vw, sh / vh);
    const width = vw * scale;
    const height = vh * scale;
    planeBox = { left: (sw - width) / 2, top: (sh - height) / 2, width, height };
  } else {
    planeBox = { left: 0, top: 0, width: Math.max(1, sw), height: Math.max(1, sh) };
  }
  plane.style.left = `${planeBox.left}px`;
  plane.style.top = `${planeBox.top}px`;
  plane.style.width = `${planeBox.width}px`;
  plane.style.height = `${planeBox.height}px`;
}

// ── the two channels: pencil (ink + video) and bar (commands) ────────────────

const session = new ClientSession({
  url: clientRelayUrl(),
  surface: () => ({ width: planeBox.width, height: planeBox.height }),
  tool,
  mode,
  video: () => video,
  onSessions: (list) => {
    setSessions(list);
    setPhase((p) => (p === "connecting" ? "picking" : p));
  },
  onJoined: () => setPhase("viewing"),
  onJoinRejected: () => setPhase("picking"),
  onHostGone: () => {
    setPhase("lost");
    setVideoUp(false);
  },
  onVideoStatus: (status) => {
    setVideoNote(
      status.state === "active"
        ? "waiting for video…"
        : status.state === "needsGesture"
          ? (status.detail ?? "the host must grant capture — waiting…")
          : status.state === "denied"
            ? `capture denied on the host${status.detail ? ` — ${status.detail}` : ""}`
            : "the host has no capture yet",
    );
  },
  onVideoUp: () => {
    setVideoUp(true);
    recomputePlane();
  },
  onVideoDown: () => setVideoUp(false),
  onClose: () => setPhase("lost"),
});

// The bar rides its own socket (D5). Auto-join pairs it with the sole host;
// when no bar host exists (a Lab without a mode engine), the component shows
// its own "waiting" note and the pencil works regardless.
const bar = createRemoteBarClient();

// ── adaptive preview fade (D3's permitted scope) ─────────────────────────────

let linkStats: LinkStats | undefined;
setInterval(() => {
  void session.stats().then((s) => {
    linkStats = s;
  });
}, 2000);

// ── the pen: one capture path, two sinks, and the iPad rules ─────────────────
//
// Ported from the paint client, which earned them on a real iPad:
//
//   - a pencil ALWAYS draws, and supersedes a stray finger mid-stroke;
//   - the first pen event latches `penMode`: from then on fingers never ink;
//   - a touch with a contact patch over 60 px is a palm — ignored outright;
//   - while the pencil is drawing, every touch is ignored;
//   - two fingers always navigate: pinch → zoom, pan → scroll (the wire's
//     plane-relative intents);
//   - one finger draws only while no pencil has EVER been seen; a mouse always
//     draws (that is the desktop rig).

let strokeSeq = 0;
/** A touch contact larger than this (either axis) is a palm, not a finger. */
const PALM_CONTACT = 60;

interface ActivePointer {
  x: number;
  y: number;
  type: string;
  palm: boolean;
  strokeId: string | null;
}
const active = new Map<number, ActivePointer>();
let drawPointer: number | null = null;
const pinch = { dist: 0, cx: 0, cy: 0 };

function localSample(e: PointerEvent): ReturnType<typeof penSample> {
  const rect = stage?.getBoundingClientRect();
  const s = penSample(e);
  // Plane-local, not stage-local: the letterbox margins are not paper.
  return {
    ...s,
    x: s.x - (rect?.left ?? 0) - planeBox.left,
    y: s.y - (rect?.top ?? 0) - planeBox.top,
  };
}

function isPalm(e: PointerEvent): boolean {
  return e.pointerType === "touch" && (e.width > PALM_CONTACT || e.height > PALM_CONTACT);
}

function drawTouches(): ActivePointer[] {
  return [...active.values()].filter((p) => p.type === "touch" && !p.palm);
}

function penDrawing(): boolean {
  if (drawPointer === null) {
    return false;
  }
  return active.get(drawPointer)?.type === "pen";
}

function beginStroke(e: PointerEvent, p: ActivePointer): void {
  const id = `c-${++strokeSeq}`;
  p.strokeId = id;
  drawPointer = e.pointerId;
  const sample = localSample(e);
  preview?.remoteBegin(id, { tool: tool(), params: resolveParams(mode()), point: sample });
  session.begin(id, sample, e.pointerType as "pen" | "touch" | "mouse");
}

/** A stroke that must not survive: a finger the pencil superseded, or a finger
 * that turned out to be the first half of a two-finger gesture. */
function cancelDraw(): void {
  if (drawPointer === null) {
    return;
  }
  const p = active.get(drawPointer);
  if (p?.strokeId) {
    preview?.remoteCancel(p.strokeId);
    session.cancel(p.strokeId);
    p.strokeId = null;
  }
  drawPointer = null;
}

function baselinePinch(): void {
  const t = drawTouches();
  if (t.length < 2) {
    return;
  }
  pinch.dist = Math.hypot(t[0].x - t[1].x, t[0].y - t[1].y);
  pinch.cx = (t[0].x + t[1].x) / 2;
  pinch.cy = (t[0].y + t[1].y) / 2;
}

/** Two fingers: pinch is zoom, drift is scroll — both plane-relative. */
function navGesture(): void {
  const t = drawTouches();
  if (t.length < 2 || !stage) {
    return;
  }
  const d = Math.hypot(t[0].x - t[1].x, t[0].y - t[1].y);
  const cx = (t[0].x + t[1].x) / 2;
  const cy = (t[0].y + t[1].y) / 2;
  if (pinch.dist > 0) {
    const rect = stage.getBoundingClientRect();
    const scale = d / pinch.dist;
    if (Math.abs(scale - 1) > 0.01) {
      session.zoom(
        (cx - rect.left - planeBox.left) / planeBox.width,
        (cy - rect.top - planeBox.top) / planeBox.height,
        scale,
      );
    }
    const du = planeBox.width > 0 ? -(cx - pinch.cx) / planeBox.width : 0;
    const dv = planeBox.height > 0 ? -(cy - pinch.cy) / planeBox.height : 0;
    if (du !== 0 || dv !== 0) {
      session.scroll(du, dv);
    }
  }
  pinch.dist = d;
  pinch.cx = cx;
  pinch.cy = cy;
}

function bindPen(element: HTMLDivElement): void {
  stage = element;
  element.addEventListener("pointerdown", (e) => {
    try {
      element.setPointerCapture(e.pointerId);
    } catch {
      // synthetic pointers have no capturable id; inking works anyway
    }
    const p: ActivePointer = {
      x: e.clientX,
      y: e.clientY,
      type: e.pointerType,
      palm: isPalm(e),
      strokeId: null,
    };
    active.set(e.pointerId, p);

    if (e.pointerType === "pen") {
      setPenMode(true);
      if (drawPointer !== null && drawPointer !== e.pointerId) {
        cancelDraw(); // the pencil supersedes a stray finger
      }
      e.preventDefault();
      beginStroke(e, p);
      return;
    }
    if (e.pointerType === "mouse") {
      if (e.button !== 0) {
        return;
      }
      e.preventDefault();
      beginStroke(e, p);
      return;
    }
    // touch
    if (p.palm || penDrawing()) {
      return; // palms never matter, and no finger interrupts the pencil
    }
    if (drawTouches().length >= 2) {
      cancelDraw(); // that first finger was half of a gesture, not a stroke
      baselinePinch();
      return;
    }
    if (!penMode()) {
      e.preventDefault();
      beginStroke(e, p);
    }
  });

  element.addEventListener("pointermove", (e) => {
    const p = active.get(e.pointerId);
    if (!p) {
      return;
    }
    p.x = e.clientX;
    p.y = e.clientY;

    if (drawPointer === e.pointerId && p.strokeId) {
      const events: PointerEvent[] =
        typeof e.getCoalescedEvents === "function" && e.getCoalescedEvents().length > 0
          ? e.getCoalescedEvents()
          : [e];
      const samples = events.map(localSample);
      for (const s of samples) {
        preview?.remotePoint(p.strokeId, s);
      }
      session.points(p.strokeId, samples);
      return;
    }
    if (drawTouches().length >= 2) {
      navGesture();
    }
  });

  const endPointer = (e: PointerEvent): void => {
    const p = active.get(e.pointerId);
    if (!p) {
      return;
    }
    active.delete(e.pointerId);
    if (drawPointer === e.pointerId) {
      if (p.strokeId) {
        preview?.remoteEnd(p.strokeId);
        session.end(p.strokeId, localSample(e));
      }
      drawPointer = null;
    }
    if (drawTouches().length >= 2) {
      baselinePinch();
    } else {
      pinch.dist = 0;
    }
  };
  element.addEventListener("pointerup", endPointer);
  element.addEventListener("pointercancel", endPointer);

  // The plane: congruent to the displayed picture; the preview lives inside it,
  // so preview pixels sit exactly over the video pixels they anticipate.
  plane = document.createElement("div");
  plane.className = "plane";
  element.append(plane);

  // The preview: the same instrument, rendering only. fadeSec IS the D3 window —
  // the shipped 500 ms until the connection has stats, then sized from them.
  preview = new PencilSurface({
    target: plane,
    className: "preview-canvas",
    localInput: false,
    params: () => resolveParams(mode()),
    fadeSec: () => fadeWindowMs(linkStats) / 1000,
    // The handoff dissolve, not the gesture warp: the video's copy of the
    // stroke arrives underneath while this fades — the less the eye is told
    // about the swap, the better (D3).
    fadeCurve: () => "crossfade",
  });

  // The plane tracks the PICTURE, whose dimensions are late and mutable.
  window.addEventListener("resize", recomputePlane);
  recomputePlane();
}

// ── the page ─────────────────────────────────────────────────────────────────

function Client(): JSX.Element {
  return (
    <main class="remote">
      <style>{CSS}</style>
      <style>{REMOTE_BAR_STYLES}</style>
      <Show when={phase() !== "viewing"}>
        <div class="picker">
          <h1>remote pencil</h1>
          <Show when={phase() === "connecting"}>
            <p>connecting…</p>
          </Show>
          <Show when={phase() === "lost"}>
            <p>the host went away. waiting for it to come back…</p>
          </Show>
          <For each={sessions()}>
            {(item) => (
              <button
                type="button"
                class="session"
                data-session={item.id}
                disabled={item.busy}
                onClick={() => session.join(item.id)}
              >
                {item.label}
                {item.project ? ` — ${item.project}` : ""}
                <span class="session-meta">
                  {item.id} · since {new Date(item.connectedAt).toLocaleTimeString()}
                  {item.busy ? " · busy" : ""}
                </span>
              </button>
            )}
          </For>
          <Show when={phase() === "picking" && sessions().length === 0}>
            <p>no hosts yet — open the Lab (or an aiui page) on the Mac.</p>
          </Show>
        </div>
      </Show>

      <div class="stage-wrap" style={{ display: phase() === "viewing" ? "flex" : "none" }}>
        <div class="stage" ref={bindPen}>
          <video
            ref={(el: HTMLVideoElement) => {
              video = el;
              // The plane tracks the PICTURE, and the picture's dimensions are
              // late and mutable: WebRTC ramps resolution up from a tiny first
              // frame, and each change fires `resize` on the video element. The
              // listener must live HERE, on the video's own ref — attaching it
              // from the stage's ref was a bet on ref ordering, and it lost.
              el.addEventListener("resize", recomputePlane);
              el.addEventListener("loadedmetadata", recomputePlane);
            }}
            autoplay
            muted
            playsinline
          />
          <Show when={!videoUp()}>
            <div class="no-video">{videoNote()}</div>
          </Show>
        </div>

        {/* the host's command bar — its own channel (D5), one component */}
        <div class="host-bar">
          <RemoteBar client={bar} />
        </div>

        <div class="bar">
          <Show when={penMode()}>
            <span
              class="pen-chip"
              title="a pencil was detected: fingers navigate, only the pencil inks"
            >
              ✍️ pencil
            </span>
          </Show>
          <button type="button" data-lit={tool() === "draw"} onClick={() => setTool("draw")}>
            ✏️ draw
          </button>
          <button type="button" data-lit={tool() === "erase"} onClick={() => setTool("erase")}>
            ◻️ erase
          </button>
          <button type="button" data-lit={mode() === "write"} onClick={() => setMode("write")}>
            write
          </button>
          <button type="button" data-lit={mode() === "sketch"} onClick={() => setMode("sketch")}>
            sketch
          </button>
          <button type="button" onClick={() => session.undo()}>
            ↩ undo
          </button>
          <button type="button" onClick={() => session.clear()}>
            ✕ clear
          </button>
        </div>
      </div>
    </main>
  );
}

const CSS = `
  * { margin: 0; box-sizing: border-box; }
  body { background: #0d0d11; color: #e8e8ee; font: 15px/1.4 system-ui, sans-serif; }
  .remote { height: 100dvh; display: flex; flex-direction: column; }
  .picker { margin: auto; text-align: center; display: flex; flex-direction: column; gap: 12px; }
  .picker h1 { font-size: 18px; font-weight: 600; }
  .session { padding: 12px 20px; border-radius: 10px; border: 1px solid #333;
             background: #1a1a22; color: inherit; font-size: 15px; cursor: pointer; }
  .session:disabled { opacity: 0.4; }
  .session-meta { display: block; font-size: 11px; color: #888; margin-top: 2px; }
  .stage-wrap { flex: 1; display: flex; flex-direction: column; min-height: 0; }
  .stage { position: relative; flex: 1; min-height: 0; touch-action: none; overflow: hidden; }
  .stage video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain;
                 background: #000; }
  .plane { position: absolute; pointer-events: none; }
  .preview-canvas { position: absolute; inset: 0; width: 100%; height: 100%;
                    pointer-events: none; }
  .no-video { position: absolute; inset: 0; display: grid; place-items: center; color: #888;
              padding: 24px; text-align: center; }
  .host-bar { background: #101016; border-top: 1px solid #26262e; }
  .bar { display: flex; gap: 8px; padding: 10px; justify-content: center;
         background: #16161c; border-top: 1px solid #26262e; }
  .bar button { padding: 10px 16px; border-radius: 8px; border: 1px solid #333;
                background: #1a1a22; color: inherit; font-size: 14px; cursor: pointer; }
  .bar button[data-lit="true"] { border-color: #7aa2ff; color: #a9c4ff; }
  .pen-chip { align-self: center; padding: 4px 10px; border-radius: 999px; font-size: 12px;
              background: #223122; color: #9fd89f; border: 1px solid #3b573b; }
`;

const root = document.getElementById("root");
if (root) {
  render(() => <Client />, root);
}
