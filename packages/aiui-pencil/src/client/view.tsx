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
import { bindPenInput } from "./pen-input";
import { createPlaneTracker } from "./plane";

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
  const [hudOpen, setHudOpen] = createSignal(true);

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
    return [
      `host ${host !== undefined ? px(host.width, host.height) : "—"}`,
      `video ${track && video !== undefined ? px(video.videoWidth, video.videoHeight) : "—"}`,
      `box ${px(box.width, box.height)}`,
      `rtt ${ms(stats?.rttMs)}`,
      `jit ${ms(stats?.jitterBufferMs)}`,
      fps,
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

    bindPenInput(element, {
      plane: tracker,
      sink: props.session,
      preview: () => preview,
      tool: props.tool,
      params: props.params,
      navigation: props.navigation,
      ...(props.onPenMode ? { onPenMode: props.onPenMode } : {}),
    });

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
        }}
        autoplay
        muted
        playsinline
      />
      <Show when={!props.videoUp}>
        <div class="no-video">{props.videoNote}</div>
      </Show>
      <button
        type="button"
        class="hud"
        data-testid="hud"
        data-open={hudOpen() ? "true" : "false"}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={() => setHudOpen(!hudOpen())}
      >
        {hudOpen() ? hudLine() : "ⓘ"}
      </button>
    </div>
  );
}
