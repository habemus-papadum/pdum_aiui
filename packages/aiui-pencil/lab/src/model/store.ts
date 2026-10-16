/** Durable ink, controls, and input measurements for the Pencil Lab. */

import {
  createInkDocument,
  emptyTelemetry,
  type InkCapture,
  type InkTool,
  inkSignals,
  observe,
  type PencilParams,
  type PencilPreset,
  PencilSurface,
  type PenInputSamples,
  WRITE,
} from "@habemus-papadum/aiui-pencil";
import { control, scope, throttled } from "@habemus-papadum/aiui-viz";
import { PadRenderer } from "./pad-renderer";
import { LabScene, type LabSceneState } from "./scene";

export const labScope = scope("pencil-lab");

/** Dispose prior view logic when Vite reevaluates this dependency module. */
const runtime = labScope.durable<{ dispose?: () => void }>("runtime", () => ({}));
runtime.dispose?.();

// ── which preset to load (loading is an action; see graph.ts) ────────────────

/** The preset the "load preset" action copies into the knobs below. */
export const baseProfile = labScope.durableSignal<PencilParams>("base-profile", WRITE);
export const preset = control<PencilPreset>({
  scope: labScope,
  value: "write",
  options: ["write", "sketch"],
});

// ── conditioning: what happens to the points before anything is drawn ────────

/** One-Euro floor cutoff (Hz). Lower = a stiller still pen, and more lag. The jitter knob. */
export const minCutoff = control({
  scope: labScope,
  value: WRITE.filter.minCutoff,
  min: 0.1,
  max: 5,
  step: 0.05,
  unit: " Hz",
});

/** One-Euro speed coefficient. Higher = the filter gets out of a fast pen's way. The lag knob. */
export const beta = control({
  scope: labScope,
  value: WRITE.filter.beta,
  min: 0,
  max: 3,
  step: 0.05,
});

/** How hard a turn counts as a corner the spline must NOT smooth through. */
export const cuspAngle = control({
  scope: labScope,
  value: Math.round((WRITE.cuspThreshold * 180) / Math.PI),
  min: 20,
  max: 170,
  step: 5,
  unit: "°",
});

/** How far along the stroke to look when judging a corner. Too small and jitter reads as corners. */
export const cuspWindow = control({
  scope: labScope,
  value: WRITE.cuspWindow,
  min: 1,
  max: 20,
  step: 0.5,
  unit: "px",
});

// ── the mark ────────────────────────────────────────────────────────────────

/** Nominal dab radius — the mark of an upright pen at full pressure. */
export const size = control({
  scope: labScope,
  value: WRITE.size,
  min: 0.4,
  max: 8,
  step: 0.1,
  unit: "px",
});

/** Dab spacing, as a fraction of dab radius. Below ~0.25 the stroke reads as solid. */
export const spacing = control({
  scope: labScope,
  value: WRITE.spacing,
  min: 0.05,
  max: 0.6,
  step: 0.01,
});

/** Base opacity of one dab, before any dynamics. The graphite's darkness. */
export const flow = control({ scope: labScope, value: WRITE.flow, min: 0.05, max: 1, step: 0.01 });

// ── dynamics ────────────────────────────────────────────────────────────────

/** Dab radius at ZERO pressure, as a fraction of full. The taper of a light touch. */
export const pressureRadiusFloor = control({
  scope: labScope,
  value: WRITE.pressureToRadius[0],
  min: 0.05,
  max: 1,
  step: 0.05,
});

/** Dab opacity at ZERO pressure, as a fraction of full. */
export const pressureAlphaFloor = control({
  scope: labScope,
  value: WRITE.pressureToAlpha[0],
  min: 0,
  max: 1,
  step: 0.05,
});

/**
 * How elliptical the dab becomes as the pen lays over. 0 = tilt ignored (always
 * round); 1 = a flat pen draws a maximally smeared dab. **This is the charcoal
 * knob** — and the one that is dead on any device that won't report tilt.
 */
export const tiltToEccentricity = control({
  scope: labScope,
  value: WRITE.tiltToEccentricity,
  min: 0,
  max: 1,
  step: 0.05,
});

/** Dab radius multiplier when the pen is FLAT. A laid-over pencil covers more paper. */
export const tiltRadiusGain = control({
  scope: labScope,
  value: WRITE.tiltToRadius[1],
  min: 1,
  max: 5,
  step: 0.1,
  unit: "×",
});

/** Dab opacity multiplier when the pen is FLAT. …and covers it more thinly. */
export const tiltAlphaGain = control({
  scope: labScope,
  value: WRITE.tiltToAlpha[1],
  min: 0.2,
  max: 1,
  step: 0.05,
  unit: "×",
});

/** Dab opacity multiplier at full speed. The only expressive signal a mouse has. */
export const velocityAlphaGain = control({
  scope: labScope,
  value: WRITE.velocityToAlpha[1],
  min: 0.2,
  max: 1,
  step: 0.05,
  unit: "×",
});

/** The speed (px/ms) at which the velocity dynamics reach their far end. */
export const velocityRef = control({
  scope: labScope,
  value: WRITE.velocityRef,
  min: 0.5,
  max: 10,
  step: 0.1,
});

// ── paper ───────────────────────────────────────────────────────────────────

/** How much the paper's tooth eats the mark. The mechanical-pencil tell. */
export const grain = control({ scope: labScope, value: WRITE.grain, min: 0, max: 1, step: 0.05 });

/** Tooth size in stroke-local units; it moves with the ink transform. */
export const grainScale = control({
  scope: labScope,
  value: WRITE.grainScale,
  min: 0.5,
  max: 8,
  step: 0.1,
  unit: "px",
});

// ── the surface ─────────────────────────────────────────────────────────────

/** Lay graphite down, or take it off. An eraser is a stroke like any other. */
export const tool = control<InkTool>({
  scope: labScope,
  value: "draw",
  options: ["draw", "erase", "erase-stroke"],
});

/** Visibility lifetime. Zero stays visible; fading retains the editable document records. */
export const fadeSec = control({
  scope: labScope,
  value: 0,
  min: 0,
  max: 12,
  step: 0.5,
  unit: " s",
});

/** Mechanical input and view controls; none classify the meaning of a mark. */
export const pencilMode = control({ scope: labScope, value: true });
export const navigationEnabled = control({ scope: labScope, value: true });
export const zoomEnabled = control({ scope: labScope, value: true });
export const rotationEnabled = control({ scope: labScope, value: true });
export const linkContent = control({ scope: labScope, value: true });
export const navigationTarget = control<"ink" | "content">({
  scope: labScope,
  value: "ink",
  options: ["ink", "content"],
});
export const contentWidth = control({
  scope: labScope,
  value: 640,
  min: 320,
  max: 960,
  step: 40,
  unit: " px",
});
export const sceneState = labScope.durableSignal<LabSceneState>("scene-state", {
  content: { x: 0, y: 0, scale: 1 },
  ink: { x: 0, y: 0, scale: 1 },
  scrollLeft: 0,
  scrollTop: 0,
});
export const sceneMappingValid = labScope.durableSignal("scene-mapping-valid", true);

// ── what the diagnostic OVERLAY draws, on top of the real paper ─────────────
//
// The Lab's point is that a tuning rig which can only show you the finished
// stroke can tell you THAT it looks wrong, never WHERE it went wrong. So every
// stage of the pipeline can be laid over the real mark. Defaults are quiet: you
// come here to look at the pencil, and turn the instrumentation on when it
// surprises you.

/** Show the raw pointer samples, exactly as the browser delivered them. */
export const showRaw = control({ scope: labScope, value: false });

/** Show the samples after the One-Euro low-pass. */
export const showFiltered = control({ scope: labScope, value: false });

/** Show the corners the spline was told not to smooth through. */
export const showCusps = control({ scope: labScope, value: false });

/** Show the dabs — as outlines, so their size, ellipse, and angle are legible. */
export const showDabs = control({ scope: labScope, value: false });

/** Fill the dabs instead of outlining them: show the brush footprint. */
export const fillDabs = control({ scope: labScope, value: false });

// ── durable state (not the control surface — the surface is curated) ────────

/** The observation callback receives every sample; UI updates are throttled. */
const inputMeasurements = labScope.durable("input-measurements", () => ({
  telemetry: emptyTelemetry(),
  observed: 0,
  accepted: 0,
}));
export const telemetry = throttled(labScope.durableSignal("telemetry", emptyTelemetry()), 4);
export const inputDecisions = throttled(
  labScope.durableSignal("input-decisions", {
    observed: 0,
    accepted: 0,
    last: "waiting for input",
  }),
  4,
);
/** Retain the last touch decision after release, where it can be read beside navigation controls. */
export const touchStatus = throttled(
  labScope.durableSignal("touch-status", "Touch: waiting for fingers on the canvas"),
  8,
);

export function observeInput(batch: PenInputSamples): void {
  if (batch.kind === "touch" && batch.phase !== "up" && batch.decision.reason !== "untracked") {
    const point = batch.samples.at(-1);
    touchStatus.set(
      `Touch ${batch.pointerId}: ${Math.round(point?.width ?? 0)} × ${Math.round(point?.height ?? 0)} px · ${batch.phase}: ${batch.decision.reason}`,
    );
  }
  inputMeasurements.observed += batch.samples.length;
  if (batch.accepted) {
    inputMeasurements.accepted += batch.samples.length;
    inputMeasurements.telemetry = observe(inputMeasurements.telemetry, batch.samples, batch);
    telemetry.set(inputMeasurements.telemetry);
  }
  inputDecisions.set({
    observed: inputMeasurements.observed,
    accepted: inputMeasurements.accepted,
    last: `${batch.kind} ${batch.phase}: ${batch.decision.reason}`,
  });
}

export function resetMeasurements(): void {
  inputMeasurements.telemetry = emptyTelemetry();
  inputMeasurements.observed = 0;
  inputMeasurements.accepted = 0;
  telemetry.set(inputMeasurements.telemetry);
  telemetry.flush();
  inputDecisions.set({ observed: 0, accepted: 0, last: "waiting for input" });
  inputDecisions.flush();
  touchStatus.set("Touch: waiting for fingers on the canvas");
  touchStatus.flush();
}

export const pad = new PadRenderer();

export interface CaptureReview {
  capture: InkCapture;
  image: string;
  applied: boolean;
  retired: number;
}
export const captureReview = labScope.durableSignal<CaptureReview | null>("capture-review", null);

/** The live control values, assembled into the parameter object the library speaks. */
export function currentParams(): PencilParams {
  const base = baseProfile.get();
  return {
    ...base,
    filter: { ...base.filter, minCutoff: minCutoff.get(), beta: beta.get() },
    cuspThreshold: (cuspAngle.get() * Math.PI) / 180,
    cuspWindow: cuspWindow.get(),

    size: size.get(),
    spacing: spacing.get(),
    flow: flow.get(),
    color: "#2b2b33",

    pressureToRadius: [pressureRadiusFloor.get(), base.pressureToRadius[1]],
    pressureToAlpha: [pressureAlphaFloor.get(), 1.0],
    tiltToEccentricity: tiltToEccentricity.get(),
    tiltToRadius: [1.0, tiltRadiusGain.get()],
    tiltToAlpha: [1.0, tiltAlphaGain.get()],
    velocityToAlpha: [1.0, velocityAlphaGain.get()],
    velocityRef: velocityRef.get(),

    grain: grain.get(),
    grainScale: grainScale.get(),
  };
}

/** Strokes retain their profile from begin; completed profiles are editable transactions. */
export const inkDocument = labScope.durable("document", () => createInkDocument());
let sceneRuntime: LabScene | undefined;
export const paper = new PencilSurface({
  document: inkDocument,
  // Keep the view detached until its component has committed the full scene DOM.
  target: document.createElement("div"),
  className: "paper-canvas",
  params: currentParams,
  tool: () => tool.get(),
  fadeSec: () => fadeSec.get(),
  inputOptions: {
    onSamples: observeInput,
    penEnabled: pencilMode.get(),
    onPenMode: () => pencilMode.set(true),
  },
  navigation: {
    enabled: () => navigationEnabled.get(),
    zoom: () => zoomEnabled.get(),
    rotate: () => rotationEnabled.get(),
    minScale: 0.1,
    maxScale: 10,
  },
  onViewportChange: (viewport) => sceneRuntime?.viewportChanged(viewport),
});

export const scene = new LabScene({
  paper,
  pad,
  state: sceneState,
  valid: sceneMappingValid,
  linked: () => linkContent.get(),
  width: () => contentWidth.get(),
});
sceneRuntime = scene;

export const ink = inkSignals(inkDocument);
let disposed = false;
const disposeRuntime = () => {
  if (disposed) return;
  disposed = true;
  const errors: unknown[] = [];
  for (const release of [
    () => scene.dispose(),
    () => ink.dispose(),
    () => paper.dispose(),
    () => pad.dispose(),
  ]) {
    try {
      release();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, "Unable to dispose all drawing views");
};
runtime.dispose = disposeRuntime;
if (import.meta.hot) import.meta.hot.dispose(disposeRuntime);
