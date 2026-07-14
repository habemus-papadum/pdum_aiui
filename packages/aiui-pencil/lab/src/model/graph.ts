/**
 * graph.ts — Pencil Lab's cell graph (playbook layer 2) and its agent surface.
 *
 * Two cells and a memo, which is all this app needs:
 *
 *  - `params` — the knobs, assembled into the `PencilParams` the library speaks.
 *  - `plans`  — every completed stroke, **re-planned from its raw samples**
 *               whenever any knob moves. This is the Lab's central trick: you
 *               draw once, then turn the filter up and watch the same stroke
 *               change under you. Tuning a pencil by re-drawing a stroke you can
 *               never draw the same way twice is not tuning, it is guessing.
 *  - `verdict`— the answer to the question phase 1 exists to ask: does this
 *               device report tilt, and does it MOVE?
 *
 * Note what is *not* here: the in-flight stroke. It never crosses into the
 * reactive graph at all (see capture.ts) — the island plans it itself, every
 * frame, at pen speed.
 */

import {
  type InkStroke,
  type InputReport,
  inputReport,
  planStroke,
  polygonArea,
  polylineLength,
  resolveParams,
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
import { PenRecorder } from "./capture";
import {
  beta,
  currentParams,
  cuspAngle,
  cuspWindow,
  flow,
  grain,
  ink,
  minCutoff,
  paper,
  preset,
  pressureAlphaFloor,
  pressureRadiusFloor,
  recorder,
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

/** The summary the readout renders — the phase-1 verdict, plus its evidence. */
export interface TelemetryReport {
  verdict: TiltVerdict;
  telemetry: Telemetry;
  /** Plain-language reading of the verdict, for the human holding the pen. */
  says: string;
  /** The other phase-1 question: are we getting every sample, and is it enough? */
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
  "lab",
  () => ({
    /**
     * Every completed stroke, re-planned under the current knobs. Both inputs
     * are declared: move a knob OR draw a stroke and this recomputes. (Reading a
     * control inside `compute` instead of the deps bundle is the out-of-sync bug
     * the guide warns about — it would leave the picture stale behind the
     * sliders, which for a tuning lab is the one unforgivable failure.)
     */
    plans: cell(
      () => ({ recorded: ink.strokes(), params: currentParams() }),
      (deps): StrokePlan[] => deps.recorded.map((r) => planStroke(r.points, deps.params)),
    ),

    /**
     * The drawing, as numbers — the worked example of the reactive surface.
     * A sibling cell computing over `ink.strokes()` + `ink.live()` exactly the
     * way the design promises a consumer can: point counts come off the raw
     * data; the enclosed area re-runs the widget's OWN pipeline (`planStroke`
     * with the live knobs — swap in your own params to disagree with it). The
     * live half updates ~15 Hz while the pen is still moving, and its snapshots
     * are cumulative, so no throttling ever cost it a point.
     */
    inkStats: cell(
      () => ({ strokes: ink.strokes(), live: ink.live(), params: currentParams() }),
      (deps): InkStats => {
        const drawn = deps.strokes.filter((s) => s.tool === "draw");
        const liveStroke = deps.live.at(-1);
        const last = liveStroke ?? drawn.at(-1);
        const enclosed =
          last === undefined
            ? 0
            : Math.abs(polygonArea(planStroke([...last.points], deps.params).densified));
        return {
          strokeCount: deps.strokes.length,
          erased: deps.strokes.length - drawn.length,
          totalPoints: deps.strokes.reduce((n, s) => n + s.points.length, 0),
          livePoints: deps.live.reduce((n, s) => n + s.points.length, 0),
          liveLengthPx: liveStroke === undefined ? 0 : polylineLength([...liveStroke.points]),
          enclosedPx2: enclosed,
        };
      },
    ),

    /** Does this device's pen report a usable orientation? Phase 1's whole question. */
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
  run: () => {
    const p = resolveParams(preset.get());
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
    return `loaded the ${preset.get()} preset`;
  },
});

/** Throw away every drawn stroke — the real paper AND the diagnostic overlay. */
export const clearStrokes = action({
  run: () => {
    paper.clear(); // ink.strokes() follows by itself — the surface owns the record
    return "cleared";
  },
});

/**
 * Clear, the way vanishing ink goes: every stroke charges, heats, and pops.
 * The same exit a fading stroke takes — an animated clear is all of them taking
 * it at once. Also D4's retire move for an overlay whose viewport changed.
 */
export const clearAnimated = action({
  run: () => {
    paper.clearAnimated();
    return "clearing — watch it pop";
  },
});

/**
 * Undo the last stroke. Free below the retention horizon, impossible above it —
 * because flattening is what makes an edit permanent, and the undo depth and the
 * horizon are the same number by construction (see surface.ts).
 */
export const undo = action({
  run: () => {
    return paper.undo()
      ? "undone"
      : "nothing to undo — the rest has been flattened past the horizon";
  },
});

/**
 * Re-bake every stroke under the current knobs.
 *
 * The Lab's central trick, and the reason strokes are stored as RAW SAMPLES:
 * committed strokes on a raster surface are pixels, so the only way to see a
 * knob's effect on ink you already drew is to throw the pixels away and re-run
 * the pipeline. Tuning a pencil by re-drawing a stroke you can never draw the
 * same way twice is not tuning, it is guessing.
 *
 * It replays through the REMOTE feed — the same path an iPad's pen will take in
 * phase 5 — so the remote surface is exercised every time a slider moves.
 */
export const rebake = action({
  run: () => {
    // Snapshot BEFORE clearing: `ink.strokes()` is the surface's own record, and
    // clear() empties it. The captured array is ours — fresh per ink() call.
    const recorded: readonly InkStroke[] = ink.strokes();
    const params = currentParams();
    paper.clear();
    recorded.forEach((stroke, i) => {
      if (stroke.points.length === 0) {
        return;
      }
      const id = `rebake-${i}`;
      // Each stroke keeps the TOOL it was drawn with — its identity — while the
      // brush parameters are the ones currently under test. Using the live tool
      // here instead replayed three pencil strokes as three eraser strokes and
      // wiped the page; the eraser was working perfectly, and the bug was that a
      // stroke did not remember what it was.
      paper.remoteBegin(id, { tool: stroke.tool, params, point: stroke.points[0] });
      for (const s of stroke.points.slice(1)) {
        paper.remotePoint(id, s);
      }
      paper.remoteEnd(id);
    });
    return `re-baked ${recorded.length} stroke(s)`;
  },
});

/** Wipe the measured telemetry, so the next tilt of the pen is measured from scratch. */
export const resetTelemetry = action({
  run: () => {
    recorder.resetTelemetry();
    telemetry.set(PenRecorder.emptySnapshot());
    return "telemetry reset — now tilt the pen and watch the ranges move";
  },
});
