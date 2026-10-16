/**
 * pipeline.ts — a build pipeline as a pure model: the stages, the edges
 * between them, the Mermaid text that draws them, and where a run stands at
 * time t. Layer 1: no DOM, no signals, unit-tested.
 *
 * The ids in the text are the ids everything else keys on — `train` is the
 * node and `e_feat_train` the edge, in the model, in the Mermaid source
 * (`feat e_feat_train@--> train`), and in the rendered SVG.
 */

export type Shape = "db" | "box" | "diamond" | "round";

export interface Stage {
  id: string;
  label: string;
  shape: Shape;
  /** Seconds the stage takes. `train` scales with epochs. */
  cost: number;
  /** Fraction of the rows that come out. */
  keep: number;
}

export interface Edge {
  id: string;
  from: string;
  to: string;
  label?: string;
}

export interface PipelineParams {
  /** Training epochs — the train stage costs `epochs * EPOCH_COST`. */
  epochs: number;
  /** With an evaluate stage between train and ship, or straight through. */
  withEval: boolean;
}

export const EPOCH_COST = 0.6;
export const ROWS_IN = 120_000;

const BASE: readonly Stage[] = [
  { id: "raw", label: "raw events", shape: "db", cost: 2, keep: 1 },
  { id: "clean", label: "clean", shape: "box", cost: 4, keep: 0.82 },
  { id: "feat", label: "featurize", shape: "box", cost: 6, keep: 0.97 },
  { id: "train", label: "train", shape: "box", cost: 0, keep: 1 },
  { id: "eval", label: "evaluate", shape: "box", cost: 3, keep: 1 },
  { id: "ship", label: "ship?", shape: "diamond", cost: 1, keep: 1 },
  { id: "deploy", label: "deploy", shape: "round", cost: 2, keep: 1 },
];

/** The stages of a run, in order, costs resolved. */
export function stagesOf(p: PipelineParams): Stage[] {
  return BASE.filter((s) => p.withEval || s.id !== "eval").map((s) =>
    s.id === "train" ? { ...s, cost: p.epochs * EPOCH_COST } : s,
  );
}

/** The edges of a run. The feedback edge (`ship` → `feat`) is a loop in the
 * drawing, never followed by the schedule. */
export function edgesOf(p: PipelineParams): Edge[] {
  const out: Edge[] = [
    { id: "e_raw_clean", from: "raw", to: "clean" },
    { id: "e_clean_feat", from: "clean", to: "feat" },
    { id: "e_feat_train", from: "feat", to: "train" },
  ];
  if (p.withEval) {
    out.push(
      { id: "e_train_eval", from: "train", to: "eval" },
      { id: "e_feat_eval", from: "feat", to: "eval", label: "holdout" },
      { id: "e_eval_ship", from: "eval", to: "ship" },
    );
  } else {
    out.push({ id: "e_train_ship", from: "train", to: "ship" });
  }
  out.push(
    { id: "e_ship_deploy", from: "ship", to: "deploy", label: "yes" },
    { id: "e_ship_feat", from: "ship", to: "feat", label: "no" },
  );
  return out;
}

const shapeOf = (s: Stage): string => {
  const q = `"${s.label}"`;
  switch (s.shape) {
    case "db":
      return `[(${q})]`;
    case "diamond":
      return `{${q}}`;
    case "round":
      return `(${q})`;
    default:
      return `[${q}]`;
  }
};

/** The Mermaid source: every node declared with its shape, the model stages
 * grouped in a subgraph, every edge named. */
export function pipelineText(p: PipelineParams): string {
  const stages = stagesOf(p);
  const inModel = new Set(["train", "eval"]);
  const lines = ["flowchart LR"];
  for (const s of stages) if (!inModel.has(s.id)) lines.push(`  ${s.id}${shapeOf(s)}`);
  lines.push("  subgraph model[model]", "    direction LR");
  for (const s of stages) if (inModel.has(s.id)) lines.push(`    ${s.id}${shapeOf(s)}`);
  lines.push("  end");
  for (const e of edgesOf(p)) {
    const label = e.label === undefined ? "" : `|${e.label}|`;
    lines.push(`  ${e.from} ${e.id}@-->${label} ${e.to}`);
  }
  return lines.join("\n");
}

export type Status = "pending" | "active" | "done";

export interface StageState {
  status: Status;
  /** 0..1 within the stage. */
  progress: number;
  start: number;
  end: number;
  rowsIn: number;
  rowsOut: number;
}

/** Where a run stands at time t (seconds): stages run back to back. */
export function schedule(p: PipelineParams, t: number): Record<string, StageState> {
  const out: Record<string, StageState> = {};
  let clock = 0;
  let rows = ROWS_IN;
  for (const s of stagesOf(p)) {
    const start = clock;
    const end = clock + s.cost;
    const rowsOut = Math.round(rows * s.keep);
    const progress = s.cost <= 0 ? 1 : Math.max(0, Math.min(1, (t - start) / s.cost));
    const status: Status = t >= end ? "done" : t > start ? "active" : "pending";
    out[s.id] = { status, progress, start, end, rowsIn: rows, rowsOut };
    rows = rowsOut;
    clock = end;
  }
  return out;
}

/** The whole run's length, in seconds. */
export function totalCost(p: PipelineParams): number {
  return stagesOf(p).reduce((sum, s) => sum + s.cost, 0);
}

/** The edge ids into and out of a stage. */
export function neighbors(p: PipelineParams, id: string): { in: string[]; out: string[] } {
  const edges = edgesOf(p);
  return {
    in: edges.filter((e) => e.to === id).map((e) => e.id),
    out: edges.filter((e) => e.from === id).map((e) => e.id),
  };
}

/** Thousands with a k, for the chips. */
export const fmtRows = (n: number): string =>
  n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
