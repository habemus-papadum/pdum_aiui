/** Editable stroke data, independent of views, canvas resources, and framework state. */
import { planStroke } from "./dabs";
import {
  applyTransform,
  type EraserCoverage,
  hitVisibleStroke,
  type InkTransform,
  invertTransform,
  validateTransform,
} from "./geometry";
import type { PencilParams } from "./pencil";
import type { PenSample } from "./telemetry";

export type { InkTransform } from "./geometry";

export type InkTool = "draw" | "erase" | "erase-stroke";

/** Continuous circular coverage along one gesture, in the affected stroke's local space. */
export type InkErasure = EraserCoverage;

export interface InkStroke {
  readonly id: string;
  readonly revision: number;
  readonly tool: "draw";
  readonly points: readonly PenSample[];
  readonly params: PencilParams;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly transform: InkTransform;
  readonly erasures: readonly InkErasure[];
}

export interface InkTarget {
  readonly id: string;
  readonly revision: number;
}

export interface InkDraft {
  readonly id: string;
  readonly revision: number;
  readonly tool: InkTool;
  readonly points: readonly PenSample[];
  readonly params: PencilParams;
  readonly startedAt: number;
  /** Only completed records present at begin are eligible for this eraser gesture. */
  readonly targets: readonly InkTarget[];
}

export interface InkSnapshot {
  readonly revision: number;
  readonly strokes: readonly InkStroke[];
  readonly live: readonly InkDraft[];
}

export interface InkChange {
  readonly kind: "begin" | "append" | "finish" | "cancel" | "edit" | "undo" | "redo" | "import";
  readonly revision: number;
  /** The input draft causing this transition; eraser drafts never become drawing records. */
  readonly inputId?: string;
  /** Changed or newly introduced completed records or live drafts. */
  readonly ids: readonly string[];
  readonly removedIds: readonly string[];
  /** The complete post-operation state, stable even if a subscriber makes another edit. */
  readonly snapshot: InkSnapshot;
}

export interface InkCapture {
  readonly revision: number;
  readonly capturedAt: number;
  readonly strokes: readonly InkStroke[];
}

export interface InkDocumentOptions {
  /** Number of completed transactions available to undo. Live updates do not consume history. */
  historyLimit?: number;
  /** Presentation clock, distinct from the sample timestamps used by numerical processing. */
  now?: () => number;
}

interface DraftBuffer {
  id: string;
  revision: number;
  tool: InkTool;
  points: PenSample[];
  params: PencilParams;
  startedAt: number;
  targets: readonly InkTarget[];
  snapshot?: InkDraft;
}

interface Transaction {
  before: readonly InkStroke[];
  after: readonly InkStroke[];
}

const IDENTITY: InkTransform = Object.freeze({ x: 0, y: 0, scale: 1 });

function cloneSample(sample: PenSample): PenSample {
  for (const key of [
    "x",
    "y",
    "t",
    "pressure",
    "altitude",
    "azimuth",
    "twist",
    "width",
    "height",
  ] as const) {
    if (!Number.isFinite(sample[key])) throw new TypeError(`Sample ${key} must be finite`);
  }
  return Object.freeze({ ...sample });
}

function cloneParams(params: PencilParams): PencilParams {
  const clone = structuredClone(params);
  for (const value of Object.values(clone)) {
    if (value && typeof value === "object") Object.freeze(value);
  }
  return Object.freeze(clone);
}

function cloneTransform(transform: InkTransform): InkTransform {
  validateTransform(transform);
  return Object.freeze({ ...transform });
}

function cloneErasure(erasure: InkErasure): InkErasure {
  return Object.freeze({
    points: Object.freeze(
      erasure.points.map((point) => {
        if (![point.x, point.y, point.radius].every(Number.isFinite) || point.radius < 0) {
          throw new TypeError(
            "Eraser coverage must have finite coordinates and a nonnegative radius",
          );
        }
        return Object.freeze({ ...point });
      }),
    ),
  });
}

function sameContent(a: InkStroke, b: InkStroke): boolean {
  return (
    a.id === b.id &&
    a.points === b.points &&
    a.params === b.params &&
    a.transform === b.transform &&
    a.erasures === b.erasures &&
    a.startedAt === b.startedAt &&
    a.endedAt === b.endedAt
  );
}

/** Freeze the current eraser footprint; a stroke transform maps it into that stroke's space. */
export function eraserCoverage(
  draft: Pick<InkDraft, "points" | "params">,
  transform: InkTransform = IDENTITY,
): InkErasure {
  const inverse = invertTransform(transform);
  if (!Number.isFinite(draft.params.size) || draft.params.size < 0) {
    throw new TypeError("Eraser size must be finite and nonnegative");
  }
  return Object.freeze({
    points: Object.freeze(
      draft.points.map((point) =>
        Object.freeze({
          ...applyTransform({ x: point.x, y: point.y }, inverse),
          radius: draft.params.size / transform.scale,
        }),
      ),
    ),
  });
}

const previews = new WeakMap<InkSnapshot, readonly InkStroke[]>();

/** Apply in-progress erasing to a view without changing the document or its undo history. */
export function previewStrokes(snapshot: InkSnapshot): readonly InkStroke[] {
  const cached = previews.get(snapshot);
  if (cached) return cached;
  const sources = new Map(snapshot.strokes.map((stroke) => [stroke.id, stroke]));
  let strokes = snapshot.strokes;
  for (const draft of snapshot.live) {
    if (draft.tool === "draw") continue;
    const targets = new Map(draft.targets.map((target) => [target.id, target.revision]));
    strokes = Object.freeze(
      strokes.flatMap((stroke) => {
        if (targets.get(stroke.id) !== sources.get(stroke.id)?.revision) return [stroke];
        const coverage = eraserCoverage(draft, stroke.transform);
        if (
          !hitVisibleStroke(
            planStroke(stroke.points, stroke.params).dabs,
            stroke.erasures,
            coverage,
          )
        ) {
          return [stroke];
        }
        if (draft.tool === "erase-stroke") return [];
        return [
          Object.freeze({
            ...stroke,
            revision: draft.revision,
            erasures: Object.freeze([...stroke.erasures, coverage]),
          }),
        ];
      }),
    );
  }
  previews.set(snapshot, strokes);
  return strokes;
}

/**
 * Authoritative ink and bounded undo history. Every returned value is immutable;
 * unchanged completed records retain identity across snapshots and live updates.
 */
export class InkDocument {
  private revision = 0;
  private strokes: readonly InkStroke[] = Object.freeze([]);
  private readonly drafts = new Map<string, DraftBuffer>();
  private readonly listeners = new Set<(change: InkChange) => void>();
  private readonly notifications: InkChange[] = [];
  private publishing = false;
  private readonly undoStack: Transaction[] = [];
  private readonly redoStack: Transaction[] = [];
  private readonly historyLimit: number;
  private readonly now: () => number;
  private cachedSnapshot?: InkSnapshot;

  constructor(options: InkDocumentOptions = {}) {
    const limit = options.historyLimit ?? 64;
    if (!Number.isSafeInteger(limit) || limit < 0) {
      throw new TypeError("historyLimit must be a nonnegative integer");
    }
    this.historyLimit = limit;
    this.now = options.now ?? (() => performance.now());
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  snapshot(): InkSnapshot {
    if (!this.cachedSnapshot) {
      const live = [...this.drafts.values()].map((draft) => {
        if (!draft.snapshot) {
          draft.snapshot = Object.freeze({
            id: draft.id,
            revision: draft.revision,
            tool: draft.tool,
            points: Object.freeze([...draft.points]),
            params: draft.params,
            startedAt: draft.startedAt,
            targets: draft.targets,
          });
        }
        return draft.snapshot;
      });
      this.cachedSnapshot = Object.freeze({
        revision: this.revision,
        strokes: this.strokes,
        live: Object.freeze(live),
      });
    }
    return this.cachedSnapshot;
  }

  subscribe(listener: (change: InkChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  begin(id: string, input: { tool: InkTool; params: PencilParams; point: PenSample }): void {
    const restorable = [...this.undoStack, ...this.redoStack].some((transaction) =>
      [...transaction.before, ...transaction.after].some((stroke) => stroke.id === id),
    );
    if (
      !id ||
      this.drafts.has(id) ||
      restorable ||
      this.strokes.some((stroke) => stroke.id === id)
    ) {
      throw new Error(`Stroke ID must be nonempty and unique: ${id}`);
    }
    if (!["draw", "erase", "erase-stroke"].includes(input.tool))
      throw new TypeError("Unknown ink tool");
    const point = cloneSample(input.point);
    const params = cloneParams(input.params);
    if (input.tool !== "draw" && (!Number.isFinite(params.size) || params.size < 0)) {
      throw new TypeError("Eraser size must be finite and nonnegative");
    }
    const targets =
      input.tool === "draw"
        ? Object.freeze([])
        : Object.freeze(
            this.strokes.map(({ id: targetId, revision }) =>
              Object.freeze({ id: targetId, revision }),
            ),
          );
    this.drafts.set(id, {
      id,
      revision: this.revision + 1,
      tool: input.tool,
      points: [point],
      params,
      startedAt: this.now(),
      targets,
    });
    this.publish("begin", [id], [], id);
  }

  append(id: string, points: readonly PenSample[]): void {
    const draft = this.drafts.get(id);
    if (!draft || points.length === 0) return;
    // Validate the entire batch before changing the draft.
    const samples = points.map(cloneSample);
    for (const sample of samples) draft.points.push(sample);
    draft.revision = this.revision + 1;
    draft.snapshot = undefined;
    this.publish("append", [id], [], id);
  }

  finish(id: string, point?: PenSample): void {
    const draft = this.drafts.get(id);
    if (!draft) return;
    const last = point ? cloneSample(point) : undefined;
    const points = last ? [...draft.points, last] : draft.points;
    const before = this.strokes;
    const changed: string[] = [];
    const removed: string[] = [];
    let after: readonly InkStroke[];
    if (draft.tool === "draw") {
      const stroke: InkStroke = Object.freeze({
        id,
        revision: this.revision + 1,
        tool: "draw",
        points: Object.freeze([...points]),
        params: draft.params,
        startedAt: draft.startedAt,
        endedAt: this.now(),
        transform: IDENTITY,
        erasures: Object.freeze([]),
      });
      after = Object.freeze([...before, stroke]);
      changed.push(id);
    } else {
      const targets = new Map(draft.targets.map((target) => [target.id, target.revision]));
      // A changed target invalidates only that target. Never erase unrelated/new ink.
      after = Object.freeze(
        before.flatMap((stroke) => {
          if (targets.get(stroke.id) !== stroke.revision) return [stroke];
          const coverage = eraserCoverage({ points, params: draft.params }, stroke.transform);
          if (
            !hitVisibleStroke(
              planStroke(stroke.points, stroke.params).dabs,
              stroke.erasures,
              coverage,
            )
          ) {
            return [stroke];
          }
          if (draft.tool === "erase-stroke") {
            removed.push(stroke.id);
            return [];
          }
          changed.push(stroke.id);
          return [
            Object.freeze({
              ...stroke,
              revision: this.revision + 1,
              erasures: Object.freeze([...stroke.erasures, coverage]),
            }),
          ];
        }),
      );
    }
    this.drafts.delete(id);
    if (changed.length || removed.length) this.commit(before, after);
    // A no-hit eraser still completes its draft, but it does not consume history.
    this.publish("finish", [...new Set([id, ...changed])], removed, id);
  }

  cancel(id: string): void {
    if (!this.drafts.delete(id)) return;
    this.publish("cancel", [], [id], id);
  }

  remove(ids: readonly string[]): void {
    this.removeRecords(ids, false);
  }

  /** Permanently retire working ink and its undo history; unrelated live drafts continue. */
  discard(ids: readonly string[]): void {
    this.removeRecords(ids, true);
  }

  /** Clear completed ink in one undoable transaction. Live input belongs to its input session. */
  clear(): void {
    this.remove(this.strokes.map((stroke) => stroke.id));
  }

  setParams(ids: readonly string[], params: PencilParams): void {
    const snapshot = cloneParams(params);
    const serialized = JSON.stringify(snapshot);
    this.edit(ids, (stroke) =>
      JSON.stringify(stroke.params) === serialized ? stroke : { ...stroke, params: snapshot },
    );
  }

  setTransform(ids: readonly string[], transform: InkTransform): void {
    const snapshot = cloneTransform(transform);
    this.edit(ids, (stroke) =>
      stroke.transform.x === snapshot.x &&
      stroke.transform.y === snapshot.y &&
      stroke.transform.scale === snapshot.scale &&
      (stroke.transform.rotation ?? 0) === (snapshot.rotation ?? 0)
        ? stroke
        : { ...stroke, transform: snapshot },
    );
  }

  /** Replace completed ink atomically. Source revisions are replaced with this document's revision. */
  import(strokes: readonly InkStroke[]): void {
    const ids = new Set<string>();
    const after = Object.freeze(
      strokes.map((stroke) => {
        if (!stroke.id || ids.has(stroke.id) || this.drafts.has(stroke.id)) {
          throw new Error(`Imported stroke ID must be nonempty and unique: ${stroke.id}`);
        }
        if (stroke.tool !== "draw") throw new TypeError("Only drawing records can be imported");
        if (![stroke.startedAt, stroke.endedAt].every(Number.isFinite)) {
          throw new TypeError("Imported stroke times must be finite");
        }
        ids.add(stroke.id);
        return Object.freeze({
          ...stroke,
          revision: this.revision + 1,
          points: Object.freeze(stroke.points.map(cloneSample)),
          params: cloneParams(stroke.params),
          transform: cloneTransform(stroke.transform),
          erasures: Object.freeze(stroke.erasures.map(cloneErasure)),
        });
      }),
    );
    if (after.length === 0 && this.strokes.length === 0) return;
    const removed = this.strokes.filter((stroke) => !ids.has(stroke.id)).map((stroke) => stroke.id);
    this.commit(this.strokes, after);
    this.publish("import", [...ids], removed);
  }

  undo(): boolean {
    const transaction = this.undoStack.pop();
    if (!transaction) return false;
    this.redoStack.push(transaction);
    this.restore(transaction.before, "undo");
    return true;
  }

  redo(): boolean {
    const transaction = this.redoStack.pop();
    if (!transaction) return false;
    this.undoStack.push(transaction);
    this.restore(transaction.after, "redo");
    return true;
  }

  capture(options: { ids?: readonly string[] } = {}): InkCapture {
    const selected = options.ids ? new Set(options.ids) : undefined;
    return Object.freeze({
      revision: this.revision,
      capturedAt: this.now(),
      strokes: selected
        ? Object.freeze(this.strokes.filter((stroke) => selected.has(stroke.id)))
        : this.strokes,
    });
  }

  /** Remove only the exact revisions submitted; later writing or revisions remain. */
  retire(capture: InkCapture): void {
    const records = new Map(capture.strokes.map((stroke) => [stroke.id, stroke]));
    this.remove(
      this.strokes
        .filter((stroke) => {
          const captured = records.get(stroke.id);
          return captured === stroke && captured.revision === stroke.revision;
        })
        .map((stroke) => stroke.id),
    );
  }

  private removeRecords(ids: readonly string[], permanent: boolean): void {
    const selected = new Set(ids);
    const removed = this.strokes
      .filter((stroke) => selected.has(stroke.id))
      .map((stroke) => stroke.id);
    if (!removed.length) return;
    const before = this.strokes;
    const after = Object.freeze(before.filter((stroke) => !selected.has(stroke.id)));
    if (permanent) {
      this.strokes = after;
      this.undoStack.length = 0;
      this.redoStack.length = 0;
    } else {
      this.commit(before, after);
    }
    this.publish("edit", [], removed);
  }

  private edit(ids: readonly string[], apply: (stroke: InkStroke) => InkStroke): void {
    const selected = new Set(ids);
    const changed: string[] = [];
    const after = Object.freeze(
      this.strokes.map((stroke) => {
        const result = selected.has(stroke.id) ? apply(stroke) : stroke;
        if (result === stroke) return stroke;
        changed.push(stroke.id);
        return Object.freeze({ ...result, revision: this.revision + 1 });
      }),
    );
    if (!changed.length) return;
    this.commit(this.strokes, after);
    this.publish("edit", changed);
  }

  private commit(before: readonly InkStroke[], after: readonly InkStroke[]): void {
    this.strokes = after;
    this.redoStack.length = 0;
    if (this.historyLimit === 0) return;
    this.undoStack.push({ before, after });
    if (this.undoStack.length > this.historyLimit) this.undoStack.shift();
  }

  private restore(records: readonly InkStroke[], kind: "undo" | "redo"): void {
    const current = new Map(this.strokes.map((stroke) => [stroke.id, stroke]));
    const selected = new Set(records.map((stroke) => stroke.id));
    const removed = this.strokes
      .filter((stroke) => !selected.has(stroke.id))
      .map((stroke) => stroke.id);
    const changed: string[] = [];
    this.strokes = Object.freeze(
      records.map((record) => {
        const previous = current.get(record.id);
        if (previous && sameContent(record, previous)) return previous;
        changed.push(record.id);
        return Object.freeze({ ...record, revision: this.revision + 1 });
      }),
    );
    this.publish(kind, changed, removed);
  }

  private publish(
    kind: InkChange["kind"],
    ids: readonly string[],
    removedIds: readonly string[] = [],
    inputId?: string,
  ): void {
    this.revision++;
    this.cachedSnapshot = undefined;
    // Materialize only for observers. Unobserved input can append without copying all its samples.
    if (!this.listeners.size) return;
    const revision = this.revision;
    const strokes = this.strokes;
    // Append-only buffers let deferred snapshots retain an exact prefix without copying
    // on every sample batch. No subscriber is forced to materialize a live snapshot.
    const live = [...this.drafts.values()].map((draft) => ({
      id: draft.id,
      revision: draft.revision,
      tool: draft.tool,
      points: draft.points,
      length: draft.points.length,
      params: draft.params,
      startedAt: draft.startedAt,
      targets: draft.targets,
    }));
    let snapshot: InkSnapshot | undefined;
    const change: InkChange = Object.freeze({
      kind,
      revision,
      inputId,
      ids: Object.freeze([...ids]),
      removedIds: Object.freeze([...removedIds]),
      get snapshot() {
        if (!snapshot) {
          snapshot = Object.freeze({
            revision,
            strokes,
            live: Object.freeze(
              live.map(({ points, length, ...draft }) =>
                Object.freeze({
                  ...draft,
                  points: Object.freeze(points.slice(0, length)),
                }),
              ),
            ),
          });
        }
        return snapshot;
      },
    });
    this.notifications.push(change);
    if (this.publishing) return;
    this.publishing = true;
    const failures: unknown[] = [];
    try {
      while (this.notifications.length) {
        const next = this.notifications.shift();
        if (!next) break;
        for (const listener of [...this.listeners]) {
          try {
            listener(next);
          } catch (error) {
            failures.push(error);
          }
        }
      }
    } finally {
      this.publishing = false;
    }
    if (failures.length) throw new AggregateError(failures, "Ink document subscribers failed");
  }
}

export function createInkDocument(options: InkDocumentOptions = {}): InkDocument {
  return new InkDocument(options);
}
