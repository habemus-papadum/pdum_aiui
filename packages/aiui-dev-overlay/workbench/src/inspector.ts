/**
 * The inspector dock: the workbench's reason to exist. Three views over the
 * same event stream, live:
 *
 *  - **Events** — every IntentEvent, timestamped relative to thread-open.
 *    This is the raw wire the eventual protocol has to carry.
 *  - **IR** — the passes, recomputed on every event: the chronological
 *    timeline (S1), the composed transcript with corrections applied (S2),
 *    and the placeholder lowered prompt (S3). Watch a pass misbehave, fix
 *    the pass, not the vibe.
 *  - **Timing** — per-segment transcription latency (speech-end → final).
 *    The number that decides REST-per-segment vs Realtime.
 *
 * Export dumps the whole stream as JSON — captured interactions become
 * fixtures to replay against future IR passes.
 */
import { composeIntent, type Engine } from "./engine";
import type { IntentEvent } from "./types";

export class Inspector {
  readonly root: HTMLDivElement;
  private readonly panes: Record<"events" | "ir" | "timing", HTMLDivElement>;
  private readonly engine: Engine;
  private threadStart = 0;

  constructor(engine: Engine) {
    this.engine = engine;
    this.root = document.createElement("div");
    this.root.className = "wb-inspector";
    this.root.innerHTML = `
      <div class="wb-insp-tabs">
        <button data-pane="events" class="active">events</button>
        <button data-pane="ir">ir</button>
        <button data-pane="timing">timing</button>
        <button class="wb-export" title="download this stream as JSON">export</button>
      </div>`;
    this.panes = {
      events: document.createElement("div"),
      ir: document.createElement("div"),
      timing: document.createElement("div"),
    };
    for (const [name, pane] of Object.entries(this.panes)) {
      pane.className = `wb-insp-pane wb-insp-${name}`;
      pane.hidden = name !== "events";
      this.root.append(pane);
    }
    const tabs = [...this.root.querySelectorAll<HTMLButtonElement>("[data-pane]")];
    for (const button of tabs) {
      button.addEventListener("click", () => {
        for (const other of tabs) {
          other.classList.toggle("active", other === button);
        }
        for (const [name, pane] of Object.entries(this.panes)) {
          pane.hidden = name !== button.dataset.pane;
        }
      });
    }
    this.root.querySelector<HTMLButtonElement>(".wb-export")?.addEventListener("click", () => {
      const blob = new Blob([JSON.stringify(this.engine.events, null, 2)], {
        type: "application/json",
      });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `aiui-intent-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    });

    engine.onEvent((event) => this.apply(event));
  }

  private apply(event: IntentEvent): void {
    if (event.type === "thread-open") {
      this.threadStart = event.at;
    }
    this.renderEvents();
    this.renderIr();
    this.renderTiming();
  }

  private renderEvents(): void {
    const pane = this.panes.events;
    pane.replaceChildren();
    for (const event of this.engine.events.slice(-200)) {
      const row = document.createElement("div");
      row.className = `wb-ev wb-ev-${event.type}`;
      const t = ((event.at - (this.threadStart || event.at)) / 1000).toFixed(2);
      row.textContent = `${t.padStart(7)}s  ${describe(event)}`;
      pane.append(row);
    }
    pane.scrollTop = pane.scrollHeight;
  }

  private renderIr(): void {
    const pane = this.panes.ir;
    const composed = composeIntent(this.engine.events, this.engine.settings.correctionPolicy);
    pane.replaceChildren();
    const lowered = stage(
      "S3 · lowered prompt (Option C: body + meta)",
      composed.prompt || "(empty)",
    );
    // The meta half of the encoding: token → absolute path, previewable on
    // hover — the same affordance the channel's trace debugger gives paths.
    for (const [key, value] of Object.entries(composed.meta)) {
      const row = document.createElement("div");
      row.className = "wb-stage-extra";
      row.append(document.createTextNode(`${key} = `));
      row.append(pathNode(value));
      lowered.append(row);
    }
    pane.append(
      stage(
        "S1 · timeline",
        composed.items
          .map((item) => (item.kind === "text" ? `“${item.text}”` : `[${item.marker}]`))
          .join("  →  ") || "(empty)",
      ),
      stage(
        "S2 · transcript + corrections",
        composed.transcript || "(empty)",
        composed.corrections.map(
          (c) => `${c.applied ? "✓" : "…"} “${c.original}” → “${c.instruction}”`,
        ),
      ),
      lowered,
      stage(
        "components in shots",
        composed.components.map((c) => `${c.component} — ${c.source}`).join("\n") || "(none)",
      ),
    );
  }

  private renderTiming(): void {
    const pane = this.panes.timing;
    pane.replaceChildren();
    let rows = 0;
    for (const event of this.engine.events) {
      const row = document.createElement("div");
      row.className = "wb-ev";
      if (event.type === "transcript-final") {
        row.textContent = `stt  seg ${event.segment}  ${event.model}  ${Math.round(
          event.latencyMs,
        )}ms${event.correction ? "  (correction)" : ""}  “${event.text.slice(0, 44)}${
          event.text.length > 44 ? "…" : ""
        }”`;
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
    }
  }
}

/** An interactive absolute-path span: image paths peek on hover, open on click. */
function pathNode(path: string): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = "wb-path";
  span.textContent = path;
  if (/\.(png|jpe?g|gif|webp|svg)$/i.test(path)) {
    const url = `/api/preview?path=${encodeURIComponent(path)}`;
    span.classList.add("img");
    span.addEventListener("mouseenter", (e) => showPeek(url, e.clientX, e.clientY));
    span.addEventListener("mouseleave", hidePeek);
    span.addEventListener("click", () => window.open(url, "_blank"));
  }
  return span;
}

let peekEl: HTMLDivElement | undefined;
function showPeek(url: string, x: number, y: number): void {
  if (!peekEl) {
    peekEl = document.createElement("div");
    peekEl.className = "wb-peek";
    document.body.append(peekEl);
  }
  const img = document.createElement("img");
  img.src = url;
  peekEl.replaceChildren(img);
  peekEl.style.left = `${Math.max(8, x - 400)}px`;
  peekEl.style.top = `${Math.min(y + 14, innerHeight - 300)}px`;
  peekEl.style.display = "block";
}
function hidePeek(): void {
  if (peekEl) {
    peekEl.style.display = "none";
  }
}

function stage(title: string, body: string, extra: string[] = []): HTMLDivElement {
  const div = document.createElement("div");
  div.className = "wb-stage";
  const h = document.createElement("div");
  h.className = "wb-stage-title";
  h.textContent = title;
  const b = document.createElement("div");
  b.className = "wb-stage-body";
  b.textContent = body;
  div.append(h, b);
  for (const line of extra) {
    const row = document.createElement("div");
    row.className = "wb-stage-extra";
    row.textContent = line;
    div.append(row);
  }
  return div;
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
    case "shot":
      return `${event.marker} · ${Math.round(event.rect.w)}×${Math.round(event.rect.h)} · ${
        event.components.length
      } component(s)${event.thumb ? "" : " · no pixels (capture not granted)"}`;
    case "correction":
      return `correction (${event.via}${
        event.model ? `, ${event.model} ${Math.round(event.latencyMs ?? 0)}ms` : ""
      }${event.patch ? ", patched" : ", plain replace"}): “${event.original}” → “${event.instruction}”`;
    case "note":
      return event.text;
  }
}
