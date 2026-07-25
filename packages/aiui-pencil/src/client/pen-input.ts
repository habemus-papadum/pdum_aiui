/**
 * pen-input.ts — the iPad pen rules, ported from retired `aiui-paint`'s client
 * (git history), which earned them on a real iPad:
 *
 *   - a pencil ALWAYS draws, and supersedes a stray finger mid-stroke;
 *   - the first pen event latches pen mode: from then on fingers never ink;
 *   - a touch with a contact patch over 60 px is a palm — ignored outright;
 *   - while the pencil is drawing, every touch is ignored;
 *   - two fingers always navigate: pinch → zoom, pan → scroll (the wire's
 *     plane-relative intents) — unless the joined session's presentation
 *     turned navigation off, in which case the gesture is inert;
 *   - one finger draws only while no pencil has EVER been seen; a mouse always
 *     draws (that is the desktop rig).
 *
 * Input policy only: the transport is injected as {@link PenSink} (the
 * `ClientSession` in the served app), the preview as {@link PenPreview}
 * (a `PencilSurface` with `localInput: false`).
 */

import type { PencilParams } from "../pencil";
import type { Tool } from "../surface";
import { type PenSample, penSample } from "../telemetry";
import type { PlaneTracker } from "./plane";

/** The transport the pen drives (the `ClientSession` surface it needs). */
export interface PenSink {
  begin(id: string, sample: PenSample, pointerType: "pen" | "touch" | "mouse"): void;
  points(id: string, samples: PenSample[]): void;
  end(id: string, sample: PenSample): void;
  cancel(id: string): void;
  scroll(du: number, dv: number): void;
  zoom(centerU: number, centerV: number, scale: number): void;
}

/** The local echo the pen also feeds (the preview surface's remote half). */
export interface PenPreview {
  remoteBegin(id: string, init: { tool: Tool; params: PencilParams; point: PenSample }): void;
  remotePoint(id: string, point: PenSample): void;
  remoteEnd(id: string, point?: PenSample): void;
  remoteCancel(id: string): void;
}

export interface PenInputDeps {
  plane: PlaneTracker;
  sink: PenSink;
  preview: () => PenPreview | undefined;
  tool: () => Tool;
  /** The preview stroke's params (preset merged with any user overrides). */
  params: () => PencilParams;
  /** Whether two-finger gestures emit scroll/zoom intents (presentation). */
  navigation: () => boolean;
  /** The first pen event was seen (drives the ✍️ chip + finger policy). */
  onPenMode?: () => void;
}

/**
 * The pen's live activity, for policy OUTSIDE the stage: the chrome guard
 * (chrome-guard.ts) refuses palm touches on the strip/bar exactly while a
 * stroke is in flight or just ended — the stage's own rules never see those
 * touches, because they land on buttons, not paper.
 */
export interface PenActivity {
  /** A pen contact is down right now. */
  penDown(): boolean;
  /** `performance.now()` of the last pen lift (0 = never). */
  lastPenUp(): number;
  /** Lifetime counters — the HUD's stroke ledger (the X-stroke hunt: which
   * leg lost a stroke is unanswerable without knowing how many this layer
   * SAW). began/ended = strokes this binder started/committed; cancelled =
   * pointercancel or supersede kills. */
  counts(): { began: number; ended: number; cancelled: number };
}

/** A touch contact larger than this (either axis) is a palm, not a finger. */
const PALM_CONTACT = 60;

interface ActivePointer {
  x: number;
  y: number;
  type: string;
  palm: boolean;
  strokeId: string | null;
}

/** Bind the whole pen policy to `element` (the stage). Returns the pen's
 * live activity, for the chrome guard outside the stage. */
export function bindPenInput(element: HTMLElement, deps: PenInputDeps): PenActivity {
  let strokeSeq = 0;
  const active = new Map<number, ActivePointer>();
  let drawPointer: number | null = null;
  let penSeen = false;
  let penContacts = 0;
  let lastPenUp = 0;
  let began = 0;
  let ended = 0;
  let cancelled = 0;
  const pinch = { dist: 0, cx: 0, cy: 0 };

  const localSample = (e: PointerEvent): PenSample => {
    const rect = element.getBoundingClientRect();
    const box = deps.plane.box();
    const s = penSample(e);
    // Plane-local, not stage-local: the letterbox margins are not paper.
    return { ...s, x: s.x - rect.left - box.left, y: s.y - rect.top - box.top };
  };

  const isPalm = (e: PointerEvent): boolean =>
    e.pointerType === "touch" && (e.width > PALM_CONTACT || e.height > PALM_CONTACT);

  const drawTouches = (): ActivePointer[] =>
    [...active.values()].filter((p) => p.type === "touch" && !p.palm);

  const penDrawing = (): boolean => drawPointer !== null && active.get(drawPointer)?.type === "pen";

  const beginStroke = (e: PointerEvent, p: ActivePointer): void => {
    const id = `c-${++strokeSeq}`;
    p.strokeId = id;
    drawPointer = e.pointerId;
    began += 1;
    const sample = localSample(e);
    deps.preview()?.remoteBegin(id, { tool: deps.tool(), params: deps.params(), point: sample });
    deps.sink.begin(id, sample, e.pointerType as "pen" | "touch" | "mouse");
  };

  /** A stroke that must not survive: a finger the pencil superseded, or a
   * finger that turned out to be the first half of a two-finger gesture. */
  const cancelDraw = (): void => {
    if (drawPointer === null) {
      return;
    }
    const p = active.get(drawPointer);
    if (p?.strokeId) {
      cancelled += 1;
      deps.preview()?.remoteCancel(p.strokeId);
      deps.sink.cancel(p.strokeId);
      p.strokeId = null;
    }
    drawPointer = null;
  };

  const baselinePinch = (): void => {
    const t = drawTouches();
    if (t.length < 2) {
      return;
    }
    pinch.dist = Math.hypot(t[0].x - t[1].x, t[0].y - t[1].y);
    pinch.cx = (t[0].x + t[1].x) / 2;
    pinch.cy = (t[0].y + t[1].y) / 2;
  };

  /** Two fingers: pinch is zoom, drift is scroll — both plane-relative. */
  const navGesture = (): void => {
    const t = drawTouches();
    if (t.length < 2) {
      return;
    }
    const d = Math.hypot(t[0].x - t[1].x, t[0].y - t[1].y);
    const cx = (t[0].x + t[1].x) / 2;
    const cy = (t[0].y + t[1].y) / 2;
    if (pinch.dist > 0 && deps.navigation()) {
      const rect = element.getBoundingClientRect();
      const box = deps.plane.box();
      const scale = d / pinch.dist;
      if (Math.abs(scale - 1) > 0.01) {
        deps.sink.zoom(
          (cx - rect.left - box.left) / box.width,
          (cy - rect.top - box.top) / box.height,
          scale,
        );
      }
      const du = box.width > 0 ? -(cx - pinch.cx) / box.width : 0;
      const dv = box.height > 0 ? -(cy - pinch.cy) / box.height : 0;
      if (du !== 0 || dv !== 0) {
        deps.sink.scroll(du, dv);
      }
    }
    pinch.dist = d;
    pinch.cx = cx;
    pinch.cy = cy;
  };

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
      penContacts += 1;
      if (!penSeen) {
        penSeen = true;
        deps.onPenMode?.();
      }
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
    if (!penSeen) {
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
        deps.preview()?.remotePoint(p.strokeId, s);
      }
      deps.sink.points(p.strokeId, samples);
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
    if (p.type === "pen") {
      penContacts = Math.max(0, penContacts - 1);
      lastPenUp = performance.now();
    }
    if (drawPointer === e.pointerId) {
      if (p.strokeId) {
        ended += 1;
        deps.preview()?.remoteEnd(p.strokeId);
        deps.sink.end(p.strokeId, localSample(e));
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

  return {
    penDown: () => penContacts > 0,
    lastPenUp: () => lastPenUp,
    counts: () => ({ began, ended, cancelled }),
  };
}
