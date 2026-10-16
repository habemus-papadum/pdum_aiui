/** Input ownership and coordinate mapping for browser, replay, and programmatic sources. */
import type { InkDocument, InkTool } from "./document";
import { type PencilParams, WRITE } from "./pencil";
import type { PenSample } from "./telemetry";

export interface InkSessionOptions {
  params?: PencilParams | (() => PencilParams);
  tool?: InkTool | (() => InkTool);
  /** Map accepted samples into document ink coordinates, preserving sensor telemetry. */
  map?: (sample: PenSample) => PenSample;
  /** Useful for readable replay/test IDs; separate sessions must use separate namespaces. */
  namespace?: string;
}

const moduleId = Math.random().toString(36).slice(2);
let sessionSequence = 0;

/** A session can cancel only its own drafts. Completed records belong to the document. */
export class InkSession {
  private readonly active = new Map<string, string>();
  private readonly namespace: string;
  private sequence = 0;
  private disposed = false;

  constructor(
    readonly document: InkDocument,
    private readonly options: InkSessionOptions = {},
  ) {
    this.namespace = options.namespace ?? `input-${moduleId}-${sessionSequence++}`;
  }

  /** Returns the globally namespaced record ID; the caller continues using its local contact ID. */
  begin(id: string, point: PenSample): string {
    if (this.disposed) throw new Error("Input session is disposed");
    if (this.active.has(id)) throw new Error(`Input contact is already active: ${id}`);
    const recordId = `${this.namespace}:${this.sequence++}:${id}`;
    const params = this.options.params ?? WRITE;
    const tool = this.options.tool ?? "draw";
    const input = {
      tool: typeof tool === "function" ? tool() : tool,
      params: typeof params === "function" ? params() : params,
      point: this.map(point),
    };
    this.active.set(id, recordId);
    try {
      this.document.begin(recordId, input);
    } catch (error) {
      // Subscribers can fail after the document committed the operation. Keep
      // ownership in that case so disposal can still cancel the contact.
      if (!this.document.snapshot().live.some((draft) => draft.id === recordId))
        this.active.delete(id);
      throw error;
    }
    return recordId;
  }

  append(id: string, points: readonly PenSample[]): void {
    const recordId = this.active.get(id);
    if (recordId)
      this.document.append(
        recordId,
        points.map((point) => this.map(point)),
      );
  }

  finish(id: string, point?: PenSample): void {
    const recordId = this.active.get(id);
    if (!recordId) return;
    try {
      this.document.finish(recordId, point ? this.map(point) : undefined);
    } catch (error) {
      if (!this.document.snapshot().live.some((draft) => draft.id === recordId))
        this.active.delete(id);
      throw error;
    }
    this.active.delete(id);
  }

  cancel(id: string): void {
    const recordId = this.active.get(id);
    if (!recordId) return;
    this.active.delete(id);
    this.document.cancel(recordId);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const ids = [...this.active.values()];
    this.active.clear();
    const failures: unknown[] = [];
    for (const id of ids) {
      try {
        this.document.cancel(id);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw new AggregateError(failures, "Input session observers failed during disposal");
  }

  private map(point: PenSample): PenSample {
    return this.options.map ? this.options.map(point) : point;
  }
}

export function createInkSession(
  document: InkDocument,
  options: InkSessionOptions = {},
): InkSession {
  return new InkSession(document, options);
}
