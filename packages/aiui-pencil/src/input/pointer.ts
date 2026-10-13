/**
 * Local pen, touch, and mouse policy, extracted from the iPad client.
 * Pencil takes priority over fingers; large contacts never ink; two fingers
 * navigate even after pen mode latches. Coordinates are CSS px within bounds.
 * No renderer, framework, video, or transport is required.
 */
import { type PenSample, penSample } from "../telemetry";

/** The drawing commands produced by pointer input. */
export interface PenSink {
  begin(id: string, sample: PenSample): void;
  points(id: string, samples: PenSample[]): void;
  end(id: string, sample: PenSample): void;
  cancel(id: string): void;
}

/** Content rectangle relative to the element, in CSS px. */
export interface InputBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PenInputOptions {
  sink: PenSink;
  /** Defaults to the whole element. Useful for an inset drawing area. */
  bounds?: () => InputBounds;
  /** Per-pointerdown veto; vetoed contacts are not captured or tracked. */
  shouldCapture?: (event: PointerEvent) => boolean;
  /** Whether navigation callbacks are enabled; default true. */
  navigation?: () => boolean;
  /** Pan delta as a fraction of bounds, opposite to finger movement. */
  onPan?: (du: number, dv: number) => void;
  /** Centre as a fraction of bounds; incremental pinch scale. */
  onZoom?: (centerU: number, centerV: number, scale: number) => void;
  /** Called once when a pen is first seen. Fingers stop inking from then on. */
  onPenMode?: () => void;
  /** Navigation is suppressed briefly after pen-up; default 500 ms. */
  navCooldownMs?: number;
  /** Monotonic clock, injectable for tests. */
  now?: () => number;
}

export interface PenInputBinding extends PenActivity {
  /** Cancel active contacts and release their captures. Keeps pen mode latched. */
  cancel(): void;
  /** Cancel active contacts and remove all listeners. Idempotent. */
  dispose(): void;
}

/**
 * The pen's live activity, for policy outside the drawing area: the control guard
 * (controls.ts) refuses palm touches on surrounding controls exactly while a
 * stroke is in flight or just ended — the stage's own rules never see those
 * touches, because they land on buttons, not paper.
 */
export interface PenActivity {
  /** A pen contact is down right now. */
  penDown(): boolean;
  /** `performance.now()` of the last pen lift (0 = never). */
  lastPenUp(): number;
  /** Lifetime counters — the HUD's ledgers (which leg lost an input is
   * unanswerable without knowing how many this layer SAW). Strokes:
   * began/ended/cancelled. Navigation: scrolls/zooms emitted. Touches:
   * touchDowns seen, palms rejected, maxTouches simultaneously tracked —
   * a pan that emits nothing names its reason here. */
  counts(): {
    began: number;
    ended: number;
    cancelled: number;
    scrolls: number;
    zooms: number;
    touchDowns: number;
    palms: number;
    maxTouches: number;
  };
}

/** A touch contact larger than this (either axis) is a palm, not a finger —
 * for INK decisions only. Contact-size reporting is device/OS-dependent
 * (measured 2026-07-25: current iPadOS reports EVERY finger > 60px, so this
 * classifier must never gate the nav gesture — it would, and did, disable
 * two-finger pan wholesale). */
const PALM_CONTACT = 60;

/** Default nav cooldown after pen-up (see PenInputDeps.navCooldownMs). */
const NAV_COOLDOWN_MS = 500;

interface ActivePointer {
  x: number;
  y: number;
  type: string;
  palm: boolean;
  strokeId: string | null;
}

/** Bind the whole pen policy to `element` (the stage). Returns the pen's
 * live activity, for the chrome guard outside the stage. */
let bindingSequence = 0;

export function bindPenInput(element: HTMLElement, deps: PenInputOptions): PenInputBinding {
  const prefix = `pointer-${++bindingSequence}`;
  const now = deps.now ?? (() => performance.now());
  const bounds =
    deps.bounds ??
    (() => ({
      left: 0,
      top: 0,
      width: element.clientWidth,
      height: element.clientHeight,
    }));
  let disposed = false;
  let strokeSeq = 0;
  const active = new Map<number, ActivePointer>();
  let drawPointer: number | null = null;
  let penSeen = false;
  let penContacts = 0;
  let lastPenUp = 0;
  let began = 0;
  let ended = 0;
  let cancelled = 0;
  let scrolls = 0;
  let zooms = 0;
  let touchDowns = 0;
  let palms = 0;
  let maxTouches = 0;
  const pinch = { dist: 0, cx: 0, cy: 0 };

  const localSample = (e: PointerEvent): PenSample => {
    const rect = element.getBoundingClientRect();
    const box = bounds();
    const s = penSample(e);
    // Content-local: an inset outside the drawing bounds is not paper.
    return { ...s, x: s.x - rect.left - box.left, y: s.y - rect.top - box.top };
  };

  const isPalm = (e: PointerEvent): boolean =>
    e.pointerType === "touch" && (e.width > PALM_CONTACT || e.height > PALM_CONTACT);

  /** The GESTURE set: every finger contact, palm classification ignored —
   * the width heuristic is unreliable (see PALM_CONTACT) and the pan gate is
   * the pen being idle, not the contact's size. */
  const gestureTouches = (): ActivePointer[] =>
    [...active.values()].filter((p) => p.type === "touch");

  const penDrawing = (): boolean => drawPointer !== null && active.get(drawPointer)?.type === "pen";

  /** Nav fires only while the pen is idle: no contact down, and past the
   * post-pen-up window in which multi-contact touches are a resting palm. */
  const navReady = (): boolean =>
    penContacts === 0 &&
    (lastPenUp === 0 || now() - lastPenUp > (deps.navCooldownMs ?? NAV_COOLDOWN_MS));

  const beginStroke = (e: PointerEvent, p: ActivePointer): void => {
    const id = `${prefix}-${++strokeSeq}`;
    p.strokeId = id;
    drawPointer = e.pointerId;
    began += 1;
    const sample = localSample(e);
    deps.sink.begin(id, sample);
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
      deps.sink.cancel(p.strokeId);
      p.strokeId = null;
    }
    drawPointer = null;
  };

  const baselinePinch = (): void => {
    const t = gestureTouches();
    if (t.length < 2) {
      return;
    }
    pinch.dist = Math.hypot(t[0].x - t[1].x, t[0].y - t[1].y);
    pinch.cx = (t[0].x + t[1].x) / 2;
    pinch.cy = (t[0].y + t[1].y) / 2;
  };

  /** Two fingers: pinch is zoom, drift is scroll — both plane-relative. */
  const navGesture = (): void => {
    const t = gestureTouches();
    if (t.length < 2) {
      return;
    }
    const d = Math.hypot(t[0].x - t[1].x, t[0].y - t[1].y);
    const cx = (t[0].x + t[1].x) / 2;
    const cy = (t[0].y + t[1].y) / 2;
    if (pinch.dist > 0 && (deps.navigation?.() ?? true)) {
      const rect = element.getBoundingClientRect();
      const box = bounds();
      const scale = d / pinch.dist;
      if (Math.abs(scale - 1) > 0.01 && deps.onZoom && box.width > 0 && box.height > 0) {
        zooms += 1;
        deps.onZoom(
          (cx - rect.left - box.left) / box.width,
          (cy - rect.top - box.top) / box.height,
          scale,
        );
      }
      const du = box.width > 0 ? -(cx - pinch.cx) / box.width : 0;
      const dv = box.height > 0 ? -(cy - pinch.cy) / box.height : 0;
      if ((du !== 0 || dv !== 0) && deps.onPan) {
        scrolls += 1;
        deps.onPan(du, dv);
      }
    }
    pinch.dist = d;
    pinch.cx = cx;
    pinch.cy = cy;
  };

  // Safari can claim a fast second stylus contact as a system gesture: cancel the touch stream so a fast second pen contact's pointerdown
  // is not claimed by the system. STYLUS TOUCHES ONLY — the bug is a pencil
  // phenomenon, and blanket-cancelling finger touchstarts starved the
  // two-finger navigation gesture (found live 2026-07-25, the same day: pans
  // stopped reaching the drawing area). Explicitly excluded controls keep clicks.
  const swallowStylus = (e: TouchEvent): void => {
    if (e.target instanceof Element && e.target.closest("[data-pencil-input-ignore]") !== null) {
      return;
    }
    for (const touch of Array.from(e.changedTouches)) {
      if ((touch as Touch & { touchType?: string }).touchType === "stylus") {
        e.preventDefault();
        return;
      }
    }
  };
  element.addEventListener("touchstart", swallowStylus, { passive: false });
  element.addEventListener("touchmove", swallowStylus, { passive: false });

  const down = (e: PointerEvent): void => {
    if (
      (e.pointerType === "mouse" && e.button !== 0) ||
      (deps.shouldCapture && !deps.shouldCapture(e)) ||
      (e.target instanceof Element && e.target.closest("[data-pencil-input-ignore]"))
    )
      return;
    if (active.has(e.pointerId)) return;
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
      if (drawPointer !== null) return;
      e.preventDefault();
      beginStroke(e, p);
      return;
    }
    // touch
    touchDowns += 1;
    if (p.palm) {
      palms += 1;
    }
    maxTouches = Math.max(maxTouches, gestureTouches().length);
    if (penDrawing()) {
      return; // no finger (or palm) interrupts the pencil
    }
    if (gestureTouches().length >= 2) {
      cancelDraw(); // that first finger was half of a gesture, not a stroke
      baselinePinch();
      return;
    }
    if (p.palm) {
      return; // palms never DRAW — ink is where the size heuristic still gates
    }
    if (!penSeen) {
      e.preventDefault();
      beginStroke(e, p);
    }
  };

  const move = (e: PointerEvent): void => {
    const p = active.get(e.pointerId);
    if (!p) {
      return;
    }
    p.x = e.clientX;
    p.y = e.clientY;

    if (drawPointer === e.pointerId && p.strokeId) {
      const coalesced = e.getCoalescedEvents?.() ?? [];
      const events = coalesced.length > 0 ? coalesced : [e];
      const samples = events.map(localSample);
      deps.sink.points(p.strokeId, samples);
      return;
    }
    if (navReady() && gestureTouches().length >= 2) {
      navGesture();
    } else {
      baselinePinch(); // Suppressed movement must not become a later jump.
    }
  };

  const endPointer = (e: PointerEvent): void => {
    const p = active.get(e.pointerId);
    if (!p) {
      return;
    }
    active.delete(e.pointerId);
    if (p.type === "pen") {
      penContacts = Math.max(0, penContacts - 1);
      lastPenUp = now();
    }
    if (drawPointer === e.pointerId) {
      if (p.strokeId) {
        if (e.type === "pointerup") {
          ended += 1;
          deps.sink.end(p.strokeId, localSample(e));
        } else {
          cancelled += 1;
          deps.sink.cancel(p.strokeId);
        }
      }
      drawPointer = null;
    }
    try {
      element.releasePointerCapture(e.pointerId);
    } catch {
      /* synthetic pointer */
    }
    if (gestureTouches().length >= 2) {
      baselinePinch();
    } else {
      pinch.dist = 0;
    }
  };
  element.addEventListener("pointerdown", down);
  element.addEventListener("pointermove", move);
  element.addEventListener("pointerup", endPointer);
  element.addEventListener("pointercancel", endPointer);
  element.addEventListener("lostpointercapture", endPointer);

  const cancel = (): void => {
    cancelDraw();
    const ids = [...active.keys()];
    active.clear();
    if (penContacts > 0) lastPenUp = now();
    penContacts = 0;
    pinch.dist = 0;
    for (const id of ids) {
      try {
        element.releasePointerCapture(id);
      } catch {
        /* synthetic pointer */
      }
    }
  };
  const view = element.ownerDocument.defaultView;
  view?.addEventListener("blur", cancel);

  return {
    cancel,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      element.removeEventListener("pointerdown", down);
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", endPointer);
      element.removeEventListener("pointercancel", endPointer);
      element.removeEventListener("lostpointercapture", endPointer);
      element.removeEventListener("touchstart", swallowStylus);
      element.removeEventListener("touchmove", swallowStylus);
      view?.removeEventListener("blur", cancel);
      cancel();
    },
    penDown: () => penContacts > 0,
    lastPenUp: () => lastPenUp,
    counts: () => ({
      began,
      ended,
      cancelled,
      scrolls,
      zooms,
      touchDowns,
      palms,
      maxTouches,
    }),
  };
}
