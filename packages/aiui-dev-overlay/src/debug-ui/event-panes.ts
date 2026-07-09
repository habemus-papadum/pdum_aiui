/**
 * The event panes: three live views over one {@link IntentEvent} stream, plus
 * export. Prototyped in the retired workbench lab, graduated here so the
 * lab and the DevTools extension render intent debugging identically.
 *
 *  - **events** — every event, timestamped relative to thread-open. The raw
 *    wire the protocol carries.
 *  - **ir** — the passes, recomputed on every update: the chronological
 *    timeline (S1), the composed transcript with corrections (S2), and the
 *    lowered Option-C prompt with token→path meta (S3). Watch a pass misbehave,
 *    fix the pass.
 *  - **timing** — per-segment transcription latency and correction-diff timing.
 *
 * Decoupled from the {@link Engine}: it takes an event array (via `update`, or
 * bound to a {@link DebugSource}), so the same panes render a live engine, a
 * captured fixture, or a channel trace's embedded event log.
 */
import { composeIntent, type IntentEvent } from "../intent-pipeline";
import { defaultPreviewUrl, type PreviewUrl, pathNode, renderPathText } from "./paths";
import type { DebugSource } from "./sources";
import { injectDebugUiStyles } from "./styles";

export interface EventPanesConfig {
  /** The correction policy the IR pass composes under (default "replace"). */
  correctionPolicy?: "replace" | "note";
  /** Resolver for image-path hover previews (default: the lab dev-server proxy). */
  previewUrl?: PreviewUrl;
  /** Document to build in (default `globalThis.document`; for jsdom/tests). */
  document?: Document;
}

type PaneName = "events" | "ir" | "timing";

export class EventPanes {
  readonly root: HTMLDivElement;
  /** Live-mutable: the lab flips `correctionPolicy` from its settings drawer. */
  readonly config: EventPanesConfig;
  private readonly doc: Document;
  private readonly panes: Record<PaneName, HTMLDivElement>;
  private events: IntentEvent[] = [];
  private unbind?: () => void;

  constructor(config: EventPanesConfig = {}) {
    this.config = config;
    this.doc = config.document ?? document;
    injectDebugUiStyles(this.doc);

    this.root = this.doc.createElement("div");
    this.root.className = "aiui-dbg";
    const tabs = this.doc.createElement("div");
    tabs.className = "aiui-dbg-tabs";
    for (const name of ["events", "ir", "timing"] as const) {
      const button = this.doc.createElement("button");
      button.type = "button";
      button.dataset.pane = name;
      button.textContent = name;
      button.className = name === "events" ? "active" : "";
      tabs.append(button);
    }
    const exportBtn = this.doc.createElement("button");
    exportBtn.type = "button";
    exportBtn.className = "aiui-dbg-export";
    exportBtn.title = "download this stream as JSON";
    exportBtn.textContent = "export";
    tabs.append(exportBtn);
    this.root.append(tabs);

    this.panes = {
      events: this.doc.createElement("div"),
      ir: this.doc.createElement("div"),
      timing: this.doc.createElement("div"),
    };
    for (const [name, pane] of Object.entries(this.panes) as [PaneName, HTMLDivElement][]) {
      pane.className = `aiui-dbg-pane aiui-dbg-${name}`;
      pane.hidden = name !== "events";
      this.root.append(pane);
    }

    const buttons = [...tabs.querySelectorAll<HTMLButtonElement>("[data-pane]")];
    for (const button of buttons) {
      button.addEventListener("click", () => {
        for (const other of buttons) {
          other.classList.toggle("active", other === button);
        }
        for (const [name, pane] of Object.entries(this.panes) as [PaneName, HTMLDivElement][]) {
          pane.hidden = name !== button.dataset.pane;
        }
      });
    }
    exportBtn.addEventListener("click", () => this.download());
  }

  /** Subscribe to a source; auto-updates on every emission. Returns unbind. */
  bind(source: DebugSource): () => void {
    this.unbind?.();
    this.unbind = source.subscribe((events) => this.update(events));
    return () => {
      this.unbind?.();
      this.unbind = undefined;
    };
  }

  /** Replace the stream and re-render all panes. */
  update(events: IntentEvent[]): void {
    this.events = events;
    this.renderEvents();
    this.renderIr();
    this.renderTiming();
  }

  /** The current stream as pretty JSON — the export payload (and a test seam). */
  exportJson(): string {
    return JSON.stringify(this.events, null, 2);
  }

  dispose(): void {
    this.unbind?.();
    this.unbind = undefined;
  }

  private get previewUrl(): PreviewUrl {
    return this.config.previewUrl ?? defaultPreviewUrl;
  }

  private threadStart(): number {
    for (let i = this.events.length - 1; i >= 0; i--) {
      if (this.events[i].type === "thread-open") {
        return this.events[i].at;
      }
    }
    return this.events[0]?.at ?? 0;
  }

  private download(): void {
    const view = this.doc.defaultView;
    const url = view?.URL ?? globalThis.URL;
    if (!url?.createObjectURL) {
      return;
    }
    const blob = new Blob([this.exportJson()], { type: "application/json" });
    const href = url.createObjectURL(blob);
    const a = this.doc.createElement("a");
    a.href = href;
    a.download = `aiui-intent-${Date.now()}.json`;
    a.click();
    url.revokeObjectURL(href);
  }

  private renderEvents(): void {
    const pane = this.panes.events;
    pane.replaceChildren();
    const base = this.threadStart();
    for (const event of this.events.slice(-200)) {
      const row = this.doc.createElement("div");
      row.className = `aiui-dbg-ev aiui-dbg-ev-${event.type}`;
      const t = ((event.at - base) / 1000).toFixed(2);
      row.textContent = `${t.padStart(7)}s  ${describe(event)}`;
      pane.append(row);
    }
    pane.scrollTop = pane.scrollHeight;
  }

  private renderIr(): void {
    const pane = this.panes.ir;
    const composed = composeIntent(this.events, this.config.correctionPolicy ?? "replace");
    pane.replaceChildren();

    const lowered = this.stage(
      "S3 · lowered prompt (Option C: body + meta)",
      composed.prompt || "(empty)",
    );
    for (const [key, value] of Object.entries(composed.meta)) {
      const row = this.doc.createElement("div");
      row.className = "aiui-dbg-stage-extra";
      row.append(this.doc.createTextNode(`${key} = `));
      row.append(pathNode(this.doc, value, this.previewUrl));
      lowered.append(row);
    }

    pane.append(
      this.stage(
        "S1 · timeline",
        composed.items
          .map((item) => {
            if (item.kind === "text") {
              return `“${item.text}”`;
            }
            if (item.kind === "code-selection") {
              return `[${item.marker ?? "code"}: ${item.sourceLoc ?? "selection"} “${clip(
                (item.text ?? "").replace(/\s+/g, " ").trim(),
              )}”]`;
            }
            if (item.kind === "app-selection") {
              // Selections are positional items now — "did my selection make
              // it in, and where?" is answered right here on the timeline.
              return `[${item.marker ?? "sel"}: “${clip(
                (item.text ?? "").replace(/\s+/g, " ").trim(),
              )}”${item.sourceLoc ? ` @ ${item.sourceLoc}` : ""}]`;
            }
            return `[${item.marker}]`;
          })
          .join("  →  ") || "(empty)",
      ),
      this.stage(
        "S2 · transcript + corrections",
        composed.transcript || "(empty)",
        composed.corrections.map(
          (c) => `${c.applied ? "✓" : "…"} “${c.original}” → “${c.instruction}”`,
        ),
      ),
      lowered,
      this.stage(
        "components in shots",
        composed.components.map((c) => `${c.component} — ${c.source}`).join("\n") || "(none)",
      ),
    );
  }

  private renderTiming(): void {
    const pane = this.panes.timing;
    pane.replaceChildren();
    let rows = 0;
    for (const event of this.events) {
      const row = this.doc.createElement("div");
      row.className = "aiui-dbg-ev";
      if (event.type === "transcript-final") {
        row.textContent = `stt  seg ${event.segment}  ${event.model}  ${Math.round(event.latencyMs)}ms${
          event.correction ? "  (correction)" : ""
        }  “${clip(event.text)}”`;
      } else if (event.type === "correction" && event.model) {
        row.textContent = `diff seg —  ${event.model}  ${Math.round(event.latencyMs ?? 0)}ms  “${
          event.original
        }” → “${event.instruction}”`;
      } else {
        continue;
      }
      rows++;
      pane.append(row);
    }
    if (!rows) {
      pane.textContent = "no model calls yet";
      pane.className = "aiui-dbg-pane aiui-dbg-timing aiui-dbg-empty";
    } else {
      pane.className = "aiui-dbg-pane aiui-dbg-timing";
    }
  }

  private stage(title: string, body: string, extra: string[] = []): HTMLDivElement {
    const div = this.doc.createElement("div");
    div.className = "aiui-dbg-stage";
    const h = this.doc.createElement("div");
    h.className = "aiui-dbg-stage-title";
    h.textContent = title;
    const b = this.doc.createElement("div");
    b.className = "aiui-dbg-stage-body";
    // The lowered prompt embeds absolute attachment paths; make them previewable.
    renderPathText(b, body, this.previewUrl);
    div.append(h, b);
    for (const line of extra) {
      const row = this.doc.createElement("div");
      row.className = "aiui-dbg-stage-extra";
      row.textContent = line;
      div.append(row);
    }
    return div;
  }
}

function clip(text: string): string {
  return text.length > 44 ? `${text.slice(0, 44)}…` : text;
}

function describe(event: IntentEvent): string {
  switch (event.type) {
    case "armed":
      return event.on ? "armed" : "disarmed";
    case "mode":
      return `mode → ${event.mode}`;
    case "thread-open":
      return `thread OPEN (${event.trigger})`;
    case "thread-close":
      return `thread CLOSE (${event.reason})`;
    case "talk-start":
      return `talk start · seg ${event.segment}`;
    case "talk-end":
      return `talk end · seg ${event.segment} · ${event.ms}ms`;
    case "transcript-delta":
      return `…seg ${event.segment}: ${event.text.slice(-40)}`;
    case "transcript-final":
      return `seg ${event.segment} FINAL (${event.model}, ${Math.round(event.latencyMs)}ms)${
        event.correction ? " [correction]" : ""
      }: ${event.text}`;
    case "stroke":
      return `stroke · ${event.points}pts @ ${Math.round(event.bounds.x)},${Math.round(event.bounds.y)}`;
    case "ink-clear":
      return event.auto ? "ink faded out" : "ink cleared";
    case "shot-drop":
      return `${event.marker} retracted (✕ on the preview thumb)`;
    case "shot":
      return `${event.marker} · ${Math.round(event.rect.w)}×${Math.round(event.rect.h)} · ${
        event.components.length
      } component(s)${event.thumb ? "" : " · no pixels (capture not granted)"}`;
    case "correction":
      return `correction (${event.via}${
        event.model ? `, ${event.model} ${Math.round(event.latencyMs ?? 0)}ms` : ""
      }${event.patch ? ", patched" : ", plain replace"}): “${event.original}” → “${event.instruction}”`;
    case "correction-undo":
      return "correction undone (Esc — the last diff popped)";
    case "app-selection":
      return `${event.marker ?? "app selection"}: “${clip(event.text)}”${
        event.sourceLoc ? ` @ ${event.sourceLoc}` : ""
      }${event.cell ? ` · cell ${event.cell}` : ""}${event.tex ? " · TeX" : ""}`;
    case "app-selection-drop":
      return `${event.marker ?? "app selection"} retracted (✕ on the chip)`;
    case "code-selection":
      return `${event.marker ?? "code selection"}${
        event.sourceLoc ? ` @ ${event.sourceLoc}` : ""
      } · ${event.lines ?? event.text.split("\n").length} line(s): “${clip(event.text)}”`;
    case "code-selection-drop":
      return `${event.marker} retracted (✕ on the chip)`;
    case "video-share":
      return event.on ? "video share ON (~1 fps)" : "video share off";
    case "note":
      return event.text;
    case "linter-note":
      return `💡 linter${event.segment !== undefined ? ` (seg ${event.segment})` : ""}: ${clip(event.text)}`;
    case "linter-tool-call":
      return `💡 linter → ${event.tool}(${clip(JSON.stringify(event.args))})`;
    case "linter-tool-result":
      return `💡 ${event.tool} ${event.ok ? "→" : "✗"} ${clip(event.summary)}`;
  }
}
