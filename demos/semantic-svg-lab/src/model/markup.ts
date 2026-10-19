/** Scripted review semantics and ink attachment. No recognition or UI state lives here. */
import {
  applyTransform,
  composeTransforms,
  type InkCapture,
  type InkStroke,
  invertTransform,
  planStroke,
} from "@habemus-papadum/aiui-pencil/core";
import { type Circuit, type Point, type Rect, resolveFeature } from "./circuit";
import { type Camera, contains, type ViewSize } from "./projection";

export interface FrozenView {
  image: string;
  size: ViewSize;
  camera: Camera;
  lens: { camera: Camera; box: Rect } | null;
  target: string;
  circuit: Circuit;
}
export interface Proposal {
  target: string;
  before: number;
  after: number;
  expectedRevision: number;
  evidenceRevision: number;
  reviewed: boolean;
}
export interface AttachedInk {
  capture: InkCapture;
  bounds: Rect;
  target: string;
  sourceAnchor: Point;
  attached: number;
  capturedOnly: number;
}
export interface Evidence {
  view: FrozenView;
  ink: InkCapture;
  inkImage: string;
  attachment: AttachedInk;
  attachmentImage: string;
}
export type WorkflowPhase =
  | "choose"
  | "mark"
  | "continue"
  | "review"
  | "applied"
  | "undone"
  | "cancelled";
export interface MarkupWorkflow {
  phase: WorkflowPhase;
  sheet?: FrozenView;
  evidence?: Evidence;
  proposal?: Proposal;
  appliedRevision?: number;
  retired?: number;
  message?: string;
}

export function scriptedValue(before: number): number {
  return before === 6800 ? 8200 : 6800;
}
export function propose(view: FrozenView, current = view.circuit, reviewed = false): Proposal {
  const feature = resolveFeature(view.target);
  if (feature.ref.part !== "R1" || feature.ref.feature !== "value")
    throw new Error("Choose a resistor value first.");
  return {
    target: view.target,
    before: current.stages[feature.ref.occurrence].resistance,
    after: scriptedValue(view.circuit.stages[feature.ref.occurrence].resistance),
    expectedRevision: current.revision,
    evidenceRevision: view.circuit.revision,
    reviewed,
  };
}
export function proposalIsStale(proposal: Proposal, current: Circuit): boolean {
  return proposal.expectedRevision !== current.revision;
}
export function laterStrokes(capture: InkCapture, strokes: readonly InkStroke[]): number {
  const originals = new Set(capture.strokes.map((stroke) => stroke.id));
  return strokes.filter((stroke) => !originals.has(stroke.id)).length;
}
function union(rectangles: Rect[]): Rect {
  if (!rectangles.length) return { x: 0, y: 0, width: 1, height: 1 };
  const x = Math.min(...rectangles.map((r) => r.x));
  const y = Math.min(...rectangles.map((r) => r.y));
  return {
    x,
    y,
    width: Math.max(...rectangles.map((r) => r.x + r.width)) - x,
    height: Math.max(...rectangles.map((r) => r.y + r.height)) - y,
  };
}
/** Conservative enclosure of the rendered brush, including transform and tilt. Erasure can only shrink it. */
function brushBounds(stroke: InkStroke): Rect {
  return union(
    planStroke(stroke.points, stroke.params).dabs.map((dab) => {
      const p = applyTransform(dab, stroke.transform);
      const radius = Math.max(dab.rx, dab.ry) * stroke.transform.scale + 2;
      return { x: p.x - radius, y: p.y - radius, width: radius * 2, height: radius * 2 };
    }),
  );
}
function encloses(outer: Rect, inner: Rect) {
  return (
    contains(outer, inner) &&
    contains(outer, { x: inner.x + inner.width, y: inner.y + inner.height })
  );
}
function intersects(a: Rect, b: Rect) {
  return (
    a.x <= b.x + b.width && a.x + a.width >= b.x && a.y <= b.y + b.height && a.y + a.height >= b.y
  );
}
/** A stroke crossing a lens boundary has no single inverse. Preserve it in the evidence, never warp it into an object annotation. */
export function attachInk(ink: InkCapture, view: FrozenView): AttachedInk {
  const anchor = resolveFeature(view.target).point;
  const strokes = ink.strokes.flatMap((stroke) => {
    const bounds = brushBounds(stroke);
    const header = view.lens && { ...view.lens.box, y: view.lens.box.y - 28, height: 28 };
    if (header && intersects(header, bounds)) return [];
    let camera = view.camera;
    if (view.lens) {
      if (encloses(view.lens.box, bounds)) camera = view.lens.camera;
      else if (intersects(view.lens.box, bounds)) return [];
    }
    const transform = composeTransforms(
      { x: -anchor.x, y: -anchor.y, scale: 1 },
      composeTransforms(invertTransform(camera), stroke.transform),
    );
    return [Object.freeze({ ...stroke, transform: Object.freeze(transform) })];
  });
  return {
    capture: Object.freeze({ ...ink, strokes: Object.freeze(strokes) }),
    bounds: union(strokes.map(brushBounds)),
    target: view.target,
    sourceAnchor: anchor,
    attached: strokes.length,
    capturedOnly: ink.strokes.length - strokes.length,
  };
}
/** Snapshot data is copied before freezing; the live document remains editable. */
export function freezeView(view: FrozenView): FrozenView {
  const copy = structuredClone(view);
  function freeze(value: object) {
    for (const child of Object.values(value)) if (child && typeof child === "object") freeze(child);
    Object.freeze(value);
  }
  freeze(copy);
  return copy;
}
