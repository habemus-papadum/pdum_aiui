/** Browser pointer capture, sample normalization, and delivery to a stroke sink. */
import type { NavigationTransform } from "../geometry";
import {
  type PenKind,
  type PenSample,
  type PenSupport,
  penKind,
  penSample,
  penSupport,
} from "../telemetry";
import {
  type ContactEffect,
  type ContactState,
  createContactState,
  type FingerDrawing,
  type InputDecision,
  isPalmContact,
  type PenMode,
  penContactDown,
  transitionContact,
} from "./policy";

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

/** Observed input includes rejected contacts. Only accepted samples enter the sink. */
export interface PenInputSamples {
  phase: "down" | "move" | "up" | "cancel";
  pointerId: number;
  kind: PenKind;
  strokeId: string | null;
  accepted: boolean;
  decision: InputDecision;
  /** Actual samples in ink coordinates, coalesced when available. */
  samples: readonly PenSample[];
  /** Predictions are diagnostic or preview data; never committed to the sink. */
  predictedSamples: readonly PenSample[];
  support: PenSupport;
  coalesced: number;
  predicted: number;
}

export interface PenInputOptions {
  sink: PenSink;
  /** Defaults to the whole element. Used for local drawing and navigation coordinates. */
  bounds?: () => InputBounds;
  /** Map a client-space sample's position and orientation into ink coordinates. */
  clientToInk?: (sample: PenSample) => PenSample;
  enabled?: boolean;
  /** Auto activates on first pen contact. Explicit requires penEnabled or setPenEnabled(true). */
  penMode?: PenMode;
  penEnabled?: boolean;
  fingerDrawing?: FingerDrawing;
  /** Optional size heuristic; browser contact dimensions alone do not identify palms. */
  palmContactPx?: number;
  /** Per-pointerdown veto; vetoed contacts are not captured or tracked. */
  shouldCapture?: (event: PointerEvent) => boolean;
  navigation?: () => boolean;
  /** One combined pan, zoom and rotation delta, in element-local CSS coordinates. */
  onNavigate?: (navigation: NavigationTransform) => void;
  /** Called when pen mode activates, automatically or explicitly. */
  onPenMode?: () => void;
  /** Navigation is suppressed during a pen contact and this long after lift; default 0 ms. */
  navCooldownMs?: number;
  now?: () => number;
  onSamples?: (batch: PenInputSamples) => void;
}

export interface PenInputCounts {
  began: number;
  ended: number;
  cancelled: number;
  scrolls: number;
  zooms: number;
  rotations: number;
  touchDowns: number;
  palms: number;
  maxTouches: number;
  observedSamples: number;
  acceptedSamples: number;
}

/** Shared activity for the drawing region and surrounding palm guards. */
export interface PenActivity {
  penDown(): boolean;
  /** Monotonic timestamp, or null if no pen contact has ended. */
  lastPenUp(): number | null;
  counts(): PenInputCounts;
}

export interface PenInputBinding extends PenActivity {
  /** Cancel all active contacts, retaining the pen-mode setting. */
  cancel(): void;
  /** Changing ownership cancels active contacts and releases pointer capture. */
  setEnabled(enabled: boolean): void;
  /** Changes pen mode and cancels contacts. Auto mode can activate again on the next pen contact. */
  setPenEnabled(enabled: boolean): void;
  penEnabled(): boolean;
  dispose(): void;
}

export function bindPenInput(element: HTMLElement, options: PenInputOptions): PenInputBinding {
  // getRandomValues also works on HTTP LAN pages; randomUUID requires a secure context.
  const prefix = `pointer-${Array.from(crypto.getRandomValues(new Uint32Array(4)), (value) => value.toString(16)).join("-")}`;
  const now = options.now ?? (() => performance.now());
  const bounds =
    options.bounds ??
    (() => ({
      left: 0,
      top: 0,
      width: element.clientWidth,
      height: element.clientHeight,
    }));
  let state: ContactState = createContactState(options);
  let disposed = false;
  let strokeSequence = 0;
  const strokeIds = new Map<number, string>();
  const counts: PenInputCounts = {
    began: 0,
    ended: 0,
    cancelled: 0,
    scrolls: 0,
    zooms: 0,
    rotations: 0,
    touchDowns: 0,
    palms: 0,
    maxTouches: 0,
    observedSamples: 0,
    acceptedSamples: 0,
  };

  const localSample = (event: PointerEvent, kind: PenKind): PenSample => {
    const sample = penSample(event);
    if (options.clientToInk) {
      return { ...options.clientToInk(sample), kind };
    }
    const rect = element.getBoundingClientRect();
    const box = bounds();
    return {
      ...sample,
      x: sample.x - rect.left - box.left,
      y: sample.y - rect.top - box.top,
      kind,
    };
  };

  const release = (id: number) => {
    try {
      element.releasePointerCapture(id);
    } catch {
      // Synthetic pointers have no browser-owned capture.
    }
  };

  const apply = (effects: readonly ContactEffect[], samples: PenSample[] = []) => {
    for (const effect of effects) {
      if (effect.type === "pen-enabled") {
        options.onPenMode?.();
      } else if (effect.type === "navigation") {
        if (!options.onNavigate) continue;
        const rect = element.getBoundingClientRect();
        const box = bounds();
        if (effect.scale !== 1) counts.zooms += 1;
        if (effect.rotation !== 0) counts.rotations += 1;
        if (effect.to.x !== effect.from.x || effect.to.y !== effect.from.y) counts.scrolls += 1;
        const local = (point: { x: number; y: number }) => ({
          x: point.x - rect.left - box.left,
          y: point.y - rect.top - box.top,
        });
        options.onNavigate({
          from: local(effect.from),
          to: local(effect.to),
          scale: effect.scale,
          rotation: effect.rotation,
        });
      } else if (effect.type === "begin") {
        const id = `${prefix}-${++strokeSequence}`;
        strokeIds.set(effect.pointerId, id);
        counts.began += 1;
        options.sink.begin(id, samples[0]);
      } else {
        const id = strokeIds.get(effect.pointerId);
        if (!id) continue;
        if (effect.type === "points") {
          options.sink.points(id, samples);
        } else {
          strokeIds.delete(effect.pointerId);
          if (effect.type === "end") {
            counts.ended += 1;
            options.sink.end(id, samples[0]);
          } else {
            counts.cancelled += 1;
            options.sink.cancel(id);
          }
        }
      }
    }
  };

  const ignoredTarget = (target: EventTarget | null) =>
    target instanceof Element && target.closest("[data-pencil-input-ignore]") !== null;

  const handle = (event: PointerEvent) => {
    if (disposed) return;
    const phase =
      event.type === "pointerdown"
        ? "down"
        : event.type === "pointermove"
          ? "move"
          : event.type === "pointerup"
            ? "up"
            : "cancel";
    const kind = penKind(event.pointerType);
    const coalesced = phase === "move" ? (event.getCoalescedEvents?.() ?? []) : [];
    const observed = coalesced.length > 0 ? coalesced : [event];
    const samples = observed.map((sample) => localSample(sample, kind));
    const predictedSamples =
      options.onSamples && phase === "move"
        ? (event.getPredictedEvents?.() ?? []).map((sample) => localSample(sample, kind))
        : [];
    const contact = {
      id: event.pointerId,
      kind,
      x: event.clientX,
      y: event.clientY,
      width: event.width,
      height: event.height,
    };
    let veto: InputDecision["reason"] | null = null;
    if (phase === "down") {
      if (kind === "mouse" && event.button !== 0) veto = "mouse-button";
      else if (ignoredTarget(event.target)) veto = "ignored-target";
      else if (options.shouldCapture && !options.shouldCapture(event)) veto = "capture-veto";
    }
    const before = state;
    const priorStrokeId = strokeIds.get(event.pointerId) ?? null;
    const transition = veto
      ? { state, effects: [], decision: { disposition: "rejected", reason: veto } as InputDecision }
      : transitionContact(
          state,
          { type: phase, contact, now: now() },
          {
            penMode: options.penMode,
            fingerDrawing: options.fingerDrawing,
            palmContactPx: options.palmContactPx,
            navigation: options.navigation?.() ?? true,
            navCooldownMs: options.navCooldownMs,
          },
        );
    state = transition.state;
    const newlyTracked =
      phase === "down" && !before.contacts.has(contact.id) && state.contacts.has(contact.id);
    if (newlyTracked) {
      try {
        element.setPointerCapture(contact.id);
      } catch {
        // Synthetic pointers are still useful for replay and testing.
      }
      if (kind === "touch") {
        counts.touchDowns += 1;
        if (isPalmContact(contact, options.palmContactPx)) counts.palms += 1;
        counts.maxTouches = Math.max(
          counts.maxTouches,
          [...state.contacts.values()].filter((entry) => entry.kind === "touch").length,
        );
      }
    }
    const accepted = transition.decision.disposition === "ink";
    if (accepted || transition.decision.disposition === "navigation") event.preventDefault();
    counts.observedSamples += samples.length;
    if (accepted) counts.acceptedSamples += samples.length;
    apply(transition.effects, samples);
    if ((phase === "up" || phase === "cancel") && before.contacts.has(contact.id))
      release(contact.id);
    options.onSamples?.({
      phase,
      pointerId: contact.id,
      kind,
      strokeId: strokeIds.get(contact.id) ?? priorStrokeId,
      accepted,
      decision: transition.decision,
      samples,
      predictedSamples,
      support: penSupport(event),
      coalesced: coalesced.length,
      predicted: predictedSamples.length,
    });
  };

  // Prevent Safari from claiming repeated stylus contacts as native gestures.
  // Finger touch events remain available to the two-finger navigation policy.
  const swallowStylus = (event: TouchEvent) => {
    if (
      !state.enabled ||
      (options.penMode === "explicit" && !state.penEnabled) ||
      ignoredTarget(event.target)
    )
      return;
    if (
      Array.from(event.changedTouches).some(
        (touch) => (touch as Touch & { touchType?: string }).touchType === "stylus",
      )
    ) {
      event.preventDefault();
    }
  };
  const reset = (changes: { enabled?: boolean; penEnabled?: boolean } = {}) => {
    const ids = [...state.contacts.keys()];
    const transition = transitionContact(state, { type: "reset", now: now(), ...changes });
    state = transition.state;
    try {
      apply(transition.effects);
    } finally {
      for (const id of ids) release(id);
    }
  };
  const cancel = () => reset();
  const view = element.ownerDocument.defaultView;
  // Capture controls event routing, not whether a stroke is finished or cancelled.
  // Real stylus input can lose capture just BEFORE pointerup. Keep the contact
  // alive until its terminal event, even if that event lands outside the canvas.
  const events = ["pointerdown", "pointermove", "pointerup", "pointercancel"] as const;
  const continuationEvents = ["pointermove", "pointerup", "pointercancel"] as const;
  const continueOutside = (event: PointerEvent) => {
    if (!state.contacts.has(event.pointerId) || event.composedPath().includes(element)) return;
    handle(event);
  };
  for (const type of events) element.addEventListener(type, handle);
  for (const type of continuationEvents)
    element.ownerDocument.addEventListener(type, continueOutside, true);
  element.addEventListener("touchstart", swallowStylus, { passive: false });
  element.addEventListener("touchmove", swallowStylus, { passive: false });
  view?.addEventListener("blur", cancel);

  return {
    cancel,
    setEnabled(enabled) {
      if (!disposed && state.enabled !== enabled) reset({ enabled });
    },
    setPenEnabled(penEnabled) {
      if (!disposed && state.penEnabled !== penEnabled) {
        reset({ penEnabled });
        if (penEnabled) options.onPenMode?.();
      }
    },
    penEnabled: () => state.penEnabled,
    penDown: () => penContactDown(state),
    lastPenUp: () => state.lastPenUp,
    counts: () => ({ ...counts }),
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const type of events) element.removeEventListener(type, handle);
      for (const type of continuationEvents)
        element.ownerDocument.removeEventListener(type, continueOutside, true);
      element.removeEventListener("touchstart", swallowStylus);
      element.removeEventListener("touchmove", swallowStylus);
      view?.removeEventListener("blur", cancel);
      reset({ enabled: false });
    },
  };
}
