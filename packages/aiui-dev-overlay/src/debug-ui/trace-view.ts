/**
 * The trace view: render a whole channel trace, live-followed.
 *
 * Where {@link EventPanes} render an intent event stream, the trace view renders
 * a *trace* — the channel's per-stage record of a lowering run (inputs → IRs →
 * lowered prompt). It is deliberately generic so it works for **any** modality
 * the debugger records: each stage shows its text (with absolute paths made
 * previewable) or its blob (image inline, else a link). The one special case is
 * a stage whose payload is an {@link IntentEvent} log — that gets the full
 * {@link EventPanes} treatment (events / IR / timing) embedded in place, which
 * is what makes the multimodal `intent-v1` traces first-class here while
 * text-concat traces still render fine.
 */
import type { IntentEvent } from "../intent-pipeline";
import { EventPanes } from "./event-panes";
import { defaultPreviewUrl, type PreviewUrl, renderPathText } from "./paths";
import { extractIntentEvents, type LiveTrace, type TraceStageLike } from "./sources";
import { injectDebugUiStyles } from "./styles";

export interface TraceViewConfig {
  /** Resolve a stage blob to a URL (cross-origin in the extension). */
  blobUrl?: (traceId: string, file: string) => string;
  /** Resolve an absolute image path to a preview URL. */
  previewUrl?: PreviewUrl;
  /** Correction policy for the embedded event panes' IR. */
  correctionPolicy?: "replace" | "note";
  document?: Document;
}

const IMAGE = /\.(png|jpe?g|gif|webp|svg)$/i;

export class TraceView {
  readonly root: HTMLDivElement;
  private readonly doc: Document;
  private readonly config: TraceViewConfig;
  private readonly head: HTMLDivElement;
  private readonly body: HTMLDivElement;
  // Reused across updates so live-follow doesn't rebuild the event panes.
  private eventPanes?: EventPanes;

  constructor(config: TraceViewConfig = {}) {
    this.config = config;
    this.doc = config.document ?? document;
    injectDebugUiStyles(this.doc);

    this.root = this.doc.createElement("div");
    this.root.className = "aiui-dbg-trace";
    this.head = this.doc.createElement("div");
    this.head.className = "aiui-dbg-trace-head";
    this.body = this.doc.createElement("div");
    this.root.append(this.head, this.body);
  }

  /** Render (or clear, when undefined) the trace. */
  update(trace: LiveTrace | undefined): void {
    this.head.replaceChildren();
    this.body.replaceChildren();
    if (!trace) {
      const empty = this.doc.createElement("div");
      empty.className = "aiui-dbg-empty";
      empty.textContent = "Select a trace to follow it live.";
      this.body.append(empty);
      return;
    }

    const h2 = this.doc.createElement("h2");
    h2.textContent = `${trace.format ?? "trace"} — ${trace.id ?? ""}`;
    const sub = this.doc.createElement("div");
    sub.className = "sub";
    sub.textContent =
      `thread ${trace.threadId ?? "?"}` +
      (trace.startedAt ? ` · started ${trace.startedAt}` : "") +
      (trace.status ? ` · ${trace.status}` : " · live");
    this.head.append(h2, sub);

    const events = extractIntentEvents(trace.stages);
    for (const stage of trace.stages) {
      this.body.append(this.renderStage(trace, stage, events));
    }
  }

  private renderStage(
    trace: LiveTrace,
    stage: TraceStageLike,
    logEvents: IntentEvent[] | undefined,
  ): HTMLElement {
    const box = this.doc.createElement("div");
    box.className = "aiui-dbg-tstage";

    const head = this.doc.createElement("div");
    head.className = "aiui-dbg-thead";
    const kind = this.doc.createElement("span");
    kind.className = `aiui-dbg-tkind ${stage.kind ?? "info"}`;
    kind.textContent = stage.kind ?? "info";
    const label = this.doc.createElement("span");
    label.textContent = stage.label ?? "";
    const at = this.doc.createElement("span");
    at.className = "at";
    at.textContent = stage.at ? new Date(stage.at).toLocaleTimeString() : "";
    head.append(kind, label, at);

    const body = this.doc.createElement("div");
    body.className = "aiui-dbg-tbody";

    // The event-log stage becomes the rich events/IR/timing panes.
    if (logEvents && isSameArray(stage.data, logEvents)) {
      const panes = this.ensureEventPanes();
      panes.update(logEvents);
      body.append(panes.root);
    } else if (stage.file) {
      const url = this.config.blobUrl?.(trace.id ?? "", stage.file) ?? stage.file;
      if (IMAGE.test(stage.file)) {
        const img = this.doc.createElement("img");
        img.src = url;
        img.alt = stage.label ?? stage.file;
        body.append(img);
      } else {
        const a = this.doc.createElement("a");
        a.href = url;
        a.textContent = stage.file;
        body.append(a);
      }
    } else if (stage.data !== undefined) {
      const pre = this.doc.createElement("pre");
      const text =
        typeof stage.data === "string" ? stage.data : JSON.stringify(stage.data, null, 2);
      renderPathText(pre, text, this.config.previewUrl ?? defaultPreviewUrl);
      body.append(pre);
    }

    box.append(head, body);
    return box;
  }

  private ensureEventPanes(): EventPanes {
    if (!this.eventPanes) {
      this.eventPanes = new EventPanes({
        document: this.doc,
        correctionPolicy: this.config.correctionPolicy,
        previewUrl: this.config.previewUrl,
      });
    }
    return this.eventPanes;
  }
}

/** Identity check: is this stage's payload the very event log we extracted? */
function isSameArray(data: unknown, events: IntentEvent[]): boolean {
  return data === events;
}
