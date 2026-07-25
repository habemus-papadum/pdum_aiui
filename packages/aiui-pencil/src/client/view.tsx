/**
 * view.tsx — `<RemoteView/>`: the display everyone shares.
 *
 * Stage + video + plane + preview, with the pen policy bound on mount. The
 * preview is a real `PencilSurface`, `localInput: false`, dissolving on the
 * D3 crossfade — sized adaptively from the connection's measured delays when
 * stats are available. This is the part of the client that must never be
 * rebuilt per application: all the coordinate correctness (letterbox plane,
 * plane-local samples, video-resize tracking) lives here and in
 * plane.ts / pen-input.ts.
 */

import type { JSX } from "@solidjs/web";
import { createSignal, Show } from "solid-js";
import type { ClientSession } from "../client-session";
import type { PencilParams } from "../pencil";
import type { Surface } from "../protocol";
import { fadeWindowMs, type LinkStats } from "../remote";
import { PencilSurface, type Tool } from "../surface";
import { penWriting } from "./chrome-guard";
import { bindPenInput, type PenActivity } from "./pen-input";
import { createPlaneTracker } from "./plane";

/** Injected by client/vite.config.ts (build AND channel dev middleware); the
 * Lab's rig serves these sources without it, hence the typeof guard. */
declare const __AIUI_CLIENT_BUILD__: string | undefined;
const CLIENT_BUILD = typeof __AIUI_CLIENT_BUILD__ === "string" ? __AIUI_CLIENT_BUILD__ : "dev";

export interface RemoteViewProps {
  session: ClientSession;
  tool: () => Tool;
  /** The preview stroke's params (preset merged with any user overrides). */
  params: () => PencilParams;
  /** Whether two-finger gestures emit scroll/zoom intents (presentation). */
  navigation: () => boolean;
  /** The link's measured delays, for the D3 fade window (undefined until known). */
  linkStats: () => LinkStats | undefined;
  /** The host's plane, as the last videoStatus reported it (HUD telemetry). */
  hostPlane?: () => Surface | undefined;
  videoUp: boolean;
  videoNote: string;
  /** The first pen event was seen (the ✍️ chip + finger policy latch). */
  onPenMode?: () => void;
  /** The pen's live activity, once bound — the chrome guard reads it. */
  onActivity?: (activity: PenActivity) => void;
  /**
   * Hand the composer the view's live seams once mounted: the plane's content
   * box (what `ClientSession.surface` must report) and the video element
   * (where the host's track lands).
   */
  expose?: (
    surface: () => { width: number; height: number },
    video: () => HTMLVideoElement | undefined,
  ) => void;
}

export function RemoteView(props: RemoteViewProps): JSX.Element {
  let stage: HTMLDivElement | undefined;
  let video: HTMLVideoElement | undefined;
  let plane: HTMLDivElement | undefined;
  let preview: PencilSurface | undefined;
  /** The pen's activity, once bound — the HUD's own palm guard reads it. */
  let pen: PenActivity | undefined;

  const tracker = createPlaneTracker({
    stage: () => stage,
    video: () => video,
    plane: () => plane,
  });

  // The HUD's geometry tick: tracker.box() and videoWidth are plain reads, so
  // every event that can move them bumps this signal (the linkStats poll — a
  // fresh object every 2 s — keeps the line honest between events regardless).
  const [geomRev, setGeomRev] = createSignal(0);
  const recompute = (): void => {
    tracker.recompute();
    setGeomRev((n) => n + 1);
  };
  // Collapsed by default (owner, 2026-07-25): the HUD is a debugging
  // instrument, not chrome — the ⓘ keeps it one tap away when a session
  // needs numbers.
  const [hudOpen, setHudOpen] = createSignal(false);

  // The stall detector: every PRESENTED frame stamps lastFrameAt (rVFC — the
  // only signal that distinguishes "frames arriving" from "a frozen last
  // frame"); a 1 s clock re-derives the age. Older Safaris without rVFC just
  // omit the segment.
  const [lastFrameAt, setLastFrameAt] = createSignal<number | undefined>(undefined);
  const [clock, setClock] = createSignal(0);
  setInterval(() => setClock((n) => n + 1), 1000);
  const watchFrames = (el: HTMLVideoElement): void => {
    const withVfc = el as HTMLVideoElement & {
      requestVideoFrameCallback?: (callback: () => void) => number;
    };
    if (typeof withVfc.requestVideoFrameCallback !== "function") {
      return;
    }
    const tick = (): void => {
      setLastFrameAt(performance.now());
      withVfc.requestVideoFrameCallback?.(tick);
    };
    withVfc.requestVideoFrameCallback(tick);
  };
  /** Seconds since the last presented frame, or undefined before the first. */
  const frameAge = (): number | undefined => {
    clock();
    const at = lastFrameAt();
    return at !== undefined ? (performance.now() - at) / 1000 : undefined;
  };
  const stalled = (): boolean => {
    const age = frameAge();
    return props.videoUp && age !== undefined && age > 3;
  };

  // The RAW pen-event ledger (X-stroke hunt, round 2): the binder saw 16 of
  // 18 strokes, so the loss is UPSTREAM of our logic. Count pen pointerdowns
  // at window-capture (did Safari deliver at all?) and stage-capture (did it
  // land in the stage subtree?), and name the last down's target. The three-way
  // split: w short = Safari/system dropped it; w>s = it landed OUTSIDE the
  // stage (the chrome); s > strokes = a stage CHILD stopped propagation.
  let rawWindow = 0;
  let rawStage = 0;
  let lastTarget = "—";
  const describeTarget = (event: PointerEvent): string => {
    const t = event.composedPath?.()[0] ?? event.target;
    if (!(t instanceof Element)) {
      return String(t);
    }
    const cls = typeof t.className === "string" && t.className !== "" ? `.${t.className}` : "";
    return `${t.tagName}${cls}`;
  };
  window.addEventListener(
    "pointerdown",
    (event) => {
      if (event.pointerType === "pen") {
        rawWindow += 1;
        lastTarget = describeTarget(event);
      }
    },
    true,
  );

  /** The three numbers that decide every coordinate bug, plus the link. */
  const hudLine = (): string => {
    geomRev();
    const px = (w: number, h: number): string => `${Math.round(w)}×${Math.round(h)}`;
    const host = props.hostPlane?.();
    const track = video !== undefined && video.videoWidth > 0;
    const box = tracker.box();
    const stats = props.linkStats();
    const ms = (v: number | undefined): string => (v !== undefined ? `${Math.round(v)}ms` : "—");
    const fps =
      stats?.frameIntervalMs !== undefined && stats.frameIntervalMs > 0
        ? `${Math.round(1000 / stats.frameIntervalMs)}fps`
        : "—fps";
    const age = frameAge();
    // The stroke ledger (the X-stroke hunt): pen = strokes this binder
    // began/ended/cancelled; pv = the preview's retained+live counts. A lost
    // stroke names its leg by which counter failed to move.
    const counts = pen?.counts();
    const snap = preview?.ink();
    return [
      CLIENT_BUILD,
      `host ${host !== undefined ? px(host.width, host.height) : "—"}`,
      `video ${track && video !== undefined ? px(video.videoWidth, video.videoHeight) : "—"}`,
      `box ${px(box.width, box.height)}`,
      `rtt ${ms(stats?.rttMs)}`,
      `jit ${ms(stats?.jitterBufferMs)}`,
      fps,
      ...(age !== undefined ? [`frame ${age < 10 ? age.toFixed(1) : Math.round(age)}s`] : []),
      ...(counts !== undefined ? [`pen ${counts.began}/${counts.ended}/${counts.cancelled}`] : []),
      ...(counts !== undefined
        ? [
            `nv ${counts.scrolls}/${counts.zooms}`,
            `tch ${counts.touchDowns}p${counts.palms}m${counts.maxTouches}`,
          ]
        : []),
      ...(snap !== undefined ? [`pv ${snap.strokes.length}+${snap.live.length}`] : []),
      `raw w${rawWindow}/s${rawStage}`,
      `tgt ${lastTarget}`,
    ].join(" · ");
  };

  props.expose?.(
    () => {
      const box = tracker.box();
      return { width: box.width, height: box.height };
    },
    () => video,
  );

  const bindStage = (element: HTMLDivElement): void => {
    stage = element;

    // The raw ledger's stage leg — CAPTURE phase, so a child's bubble-phase
    // stopPropagation cannot hide the event from this counter.
    element.addEventListener(
      "pointerdown",
      (event) => {
        if (event.pointerType === "pen") {
          rawStage += 1;
        }
      },
      true,
    );

    // The plane: congruent to the displayed picture; the preview lives inside
    // it, so preview pixels sit exactly over the video pixels they anticipate.
    plane = document.createElement("div");
    plane.className = "plane";
    element.append(plane);

    // The preview: the same instrument, rendering only. fadeSec IS the D3
    // window — the shipped 500 ms until the connection has stats, then sized
    // from them. The handoff dissolve, not the gesture warp: the video's copy
    // of the stroke arrives underneath while this fades — the less the eye is
    // told about the swap, the better (D3).
    preview = new PencilSurface({
      target: plane,
      className: "preview-canvas",
      localInput: false,
      params: props.params,
      fadeSec: () => fadeWindowMs(props.linkStats()) / 1000,
      fadeCurve: () => "crossfade",
    });

    const activity = bindPenInput(element, {
      plane: tracker,
      sink: props.session,
      preview: () => preview,
      tool: props.tool,
      params: props.params,
      navigation: props.navigation,
      ...(props.onPenMode ? { onPenMode: props.onPenMode } : {}),
    });
    pen = activity;
    props.onActivity?.(activity);

    // The plane tracks the PICTURE, whose dimensions are late and mutable.
    window.addEventListener("resize", recompute);
    recompute();
  };

  return (
    <div class="stage" ref={bindStage}>
      <video
        ref={(el: HTMLVideoElement) => {
          video = el;
          // The plane tracks the PICTURE, and the picture's dimensions are
          // late and mutable: WebRTC ramps resolution up from a tiny first
          // frame, and each change fires `resize` on the video element. The
          // listener must live HERE, on the video's own ref — attaching it
          // from the stage's ref was a bet on ref ordering, and it lost.
          el.addEventListener("resize", recompute);
          el.addEventListener("loadedmetadata", recompute);
          watchFrames(el);
        }}
        autoplay
        muted
        playsinline
      />
      <Show when={!props.videoUp}>
        <div class="no-video">{props.videoNote}</div>
      </Show>
      {/* The HUD sits exactly where a writing palm lands (found live
          2026-07-25: a resting palm is a LONG-PRESS, which text-selected the
          HUD's label and iOS's selection UI then ate the pen). Its text is
          unselectable (styles.ts), and a touch while the pen is writing
          neither toggles it nor reaches the stage. */}
      <button
        type="button"
        class="hud"
        data-testid="hud"
        data-open={hudOpen() ? "true" : "false"}
        data-stale={stalled() ? "true" : "false"}
        onPointerDown={(event) => {
          event.stopPropagation();
          if (event.pointerType === "touch" && penWriting(pen)) {
            event.preventDefault();
          }
        }}
        onClick={() => {
          if (!penWriting(pen)) {
            setHudOpen(!hudOpen());
          }
        }}
      >
        {hudOpen() ? hudLine() : "ⓘ"}
      </button>
    </div>
  );
}
