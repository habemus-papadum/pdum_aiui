/** Reactive diagnostics and shared human/agent actions for editable ink. */

import {
  type InputReport,
  inputReport,
  pencilPreset,
  planStroke,
  polygonArea,
  polylineLength,
  type StrokePlan,
  type Telemetry,
  type TiltVerdict,
  tiltVerdict,
} from "@habemus-papadum/aiui-pencil";
import {
  action,
  agentToolkit,
  cell,
  hotCellGraph,
  registerStandardTools,
} from "@habemus-papadum/aiui-viz";
import {
  baseProfile,
  beta,
  captureReview,
  currentParams,
  cuspAngle,
  cuspWindow,
  flow,
  grain,
  grainScale,
  ink,
  labScope,
  minCutoff,
  paper,
  preset,
  pressureAlphaFloor,
  pressureRadiusFloor,
  resetMeasurements,
  size,
  spacing,
  telemetry,
  tiltAlphaGain,
  tiltRadiusGain,
  tiltToEccentricity,
  velocityAlphaGain,
  velocityRef,
} from "./store";

export { currentParams };

/** What `inkStats` reports — the drawing reduced to numbers a readout can show. */
export interface InkStats {
  strokeCount: number;
  erased: number;
  totalPoints: number;
  /** Points captured so far in the stroke UNDER THE PEN — moves mid-stroke. */
  livePoints: number;
  liveLengthPx: number;
  /** Shoelace area of the newest stroke's densified path: "what did I circle?" */
  enclosedPx2: number;
}

/** The observed device capabilities and their numerical evidence. */
export interface TelemetryReport {
  verdict: TiltVerdict;
  telemetry: Telemetry;
  /** Plain-language reading of the verdict, for the human holding the pen. */
  says: string;
  /** Sample availability and observed input rate. */
  input: InputReport;
}

const VERDICT_TEXT: Record<TiltVerdict, string> = {
  unknown: "Move the pen. Nothing has been measured yet.",
  absent:
    "No orientation data at all. Not a failure — pressure and velocity still carry the stroke, and the tilt terms go quiet on their own.",
  flat: "The field is PRESENT but never moved. It is a stub, and the tilt half of the pencil is dead on this device.",
  derived: "Orientation derived from tiltX/tiltY, and it moves. The tilt design is alive.",
  native:
    "Orientation reported natively (altitude/azimuth), and it moves. The tilt design is alive.",
};

export const graph = hotCellGraph(
  labScope.name,
  () => ({
    plans: cell(
      () => ({ recorded: ink.strokes() }),
      (deps): StrokePlan[] => deps.recorded.map((r) => planStroke(r.points, r.params)),
      { scope: labScope },
    ),

    inkStats: cell(
      () => ({ strokes: ink.strokes(), live: ink.live() }),
      (deps): InkStats => {
        const liveStroke = deps.live.at(-1);
        const last = liveStroke ?? deps.strokes.at(-1);
        const enclosed =
          last === undefined
            ? 0
            : Math.abs(polygonArea(planStroke(last.points, last.params).densified));
        return {
          strokeCount: deps.strokes.length,
          erased: deps.strokes.filter((stroke) => stroke.erasures.length > 0).length,
          totalPoints: deps.strokes.reduce((n, s) => n + s.points.length, 0),
          livePoints: deps.live.reduce((n, s) => n + s.points.length, 0),
          liveLengthPx: liveStroke === undefined ? 0 : polylineLength([...liveStroke.points]),
          enclosedPx2: enclosed,
        };
      },
      { scope: labScope },
    ),

    /** Does this device report a changing pen orientation? */
    verdict: cell(
      () => ({ t: telemetry.get() }),
      (deps): TelemetryReport => {
        const v = tiltVerdict(deps.t);
        return {
          verdict: v,
          telemetry: deps.t,
          says: VERDICT_TEXT[v],
          input: inputReport(deps.t),
        };
      },
      { scope: labScope },
    ),
  }),
  import.meta.hot,
);

export type LabGraph = ReturnType<typeof graph>;

// ── the agent surface ────────────────────────────────────────────────────────
//
// Every control above is already an agent-writable parameter through the derived
// `set` tool, and `report` shows them with their live dependency edges. Which
// means the tuning loop works for Claude exactly as it works for a human: read
// the report, set a knob, look at the canvas. That is not a bonus feature — a
// pencil tuned only by the person who can hold the pen is a pencil the agent can
// never help with.

const kit = agentToolkit("pencil-lab");
registerStandardTools(kit);

/** Load the selected preset's numbers into every knob. They are yours to tweak afterwards. */
export const loadPreset = action({
  scope: labScope,
  run: () => {
    const p = pencilPreset(preset.get());
    baseProfile.set(p);
    minCutoff.set(p.filter.minCutoff);
    beta.set(p.filter.beta);
    cuspAngle.set(Math.round((p.cuspThreshold * 180) / Math.PI));
    cuspWindow.set(p.cuspWindow);
    size.set(p.size);
    spacing.set(p.spacing);
    flow.set(p.flow);
    pressureRadiusFloor.set(p.pressureToRadius[0]);
    pressureAlphaFloor.set(p.pressureToAlpha[0]);
    tiltToEccentricity.set(p.tiltToEccentricity);
    tiltRadiusGain.set(p.tiltToRadius[1]);
    tiltAlphaGain.set(p.tiltToAlpha[1]);
    velocityAlphaGain.set(p.velocityToAlpha[1]);
    velocityRef.set(p.velocityRef);
    grain.set(p.grain);
    grainScale.set(p.grainScale);
    return `loaded the ${preset.get()} preset`;
  },
});

export const clearStrokes = action({
  scope: labScope,
  run: () => {
    paper.document.clear();
    return "cleared completed ink";
  },
});

export const fadeCompleted = action({
  scope: labScope,
  run: () => {
    paper.fadeCompleted();
    return "fading completed ink";
  },
});

export const undo = action({
  scope: labScope,
  run: () => (paper.document.undo() ? "undone" : "nothing to undo"),
});
export const redo = action({
  scope: labScope,
  run: () => (paper.document.redo() ? "redone" : "nothing to redo"),
});

/** Change completed profiles without replacing stroke identity or original samples. */
export const applyParams = action({
  scope: labScope,
  run: () => {
    const strokes = paper.document.snapshot().strokes;
    paper.document.setParams(
      strokes.map((stroke) => stroke.id),
      currentParams(),
    );
    return `updated ${strokes.length} stroke profile(s)`;
  },
});

export const evictCache = action({
  scope: labScope,
  run: () => {
    paper.view.evictCache();
    return "render cache evicted; ink and undo history retained";
  },
});

export const captureInk = action({
  scope: labScope,
  run: () => {
    const capture = paper.document.capture();
    const size = paper.view.size();
    const image = paper.view.renderCapture(capture, size.width, size.height).toDataURL("image/png");
    captureReview.set({ capture, image, applied: false, retired: 0 });
    return `captured ${capture.strokes.length} stroke(s); keep drawing before applying the sample result`;
  },
});

/** A deterministic application fixture: the result does not attempt to recognize handwriting. */
export const applySampleResult = action({
  scope: labScope,
  run: () => {
    const review = captureReview.get();
    if (!review || review.applied) return "capture ink first";
    const before = paper.document.snapshot().strokes.length;
    paper.document.retire(review.capture);
    captureReview.set({
      ...review,
      applied: true,
      retired: before - paper.document.snapshot().strokes.length,
    });
    return "sample result applied; newer ink and revised strokes remain";
  },
});

export const resetTelemetry = action({
  scope: labScope,
  run: () => {
    resetMeasurements();
    return "telemetry reset";
  },
});

if (import.meta.hot) import.meta.hot.accept();
