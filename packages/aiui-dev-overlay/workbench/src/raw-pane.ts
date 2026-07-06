/**
 * The Raw pane: everything on the wire, as JSON trees.
 *
 * Renders the channel's frame log (hello / chunk / fin / ack / push, both
 * directions) as it streams in from the shared {@link FramesFeed} — the "look
 * at the raw MCP-server output" view. Structured payloads use the shared
 * debug-ui JSON tree so this pane and the DevTools stage views stay one
 * implementation.
 */
import { renderJsonTree } from "@habemus-papadum/aiui-dev-overlay/debug-ui";
import type { FrameEntry, FramesFeed } from "./frames-feed";

/** Keep the DOM bounded; the server ring is the real buffer. */
const MAX_ROWS = 300;

export class RawPane {
  readonly root: HTMLDivElement;
  private readonly log: HTMLDivElement;
  private paused = false;
  private unsubscribe: (() => void) | undefined;

  constructor(private readonly feed: FramesFeed) {
    this.root = document.createElement("div");
    this.root.className = "wb-raw";

    const bar = document.createElement("label");
    bar.className = "wb-traces-bar";
    const pause = document.createElement("input");
    pause.type = "checkbox";
    pause.addEventListener("change", () => {
      this.paused = pause.checked;
    });
    bar.append(pause, document.createTextNode(" pause"));

    this.log = document.createElement("div");
    this.log.className = "wb-raw-log";
    this.root.append(bar, this.log);
  }

  activate(): void {
    if (this.unsubscribe) {
      return;
    }
    // Rebuild from scratch: subscribing replays the feed's full buffered
    // history (see FramesFeed), so rows left from a previous activation
    // would otherwise render twice.
    this.log.replaceChildren();
    this.unsubscribe = this.feed.subscribe((entries) => this.append(entries));
  }

  deactivate(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  private append(entries: FrameEntry[]): void {
    if (this.paused) {
      return;
    }
    const stickToBottom = this.log.scrollTop + this.log.clientHeight >= this.log.scrollHeight - 24;
    for (const entry of entries) {
      this.log.append(renderFrameRow(entry));
    }
    while (this.log.childElementCount > MAX_ROWS) {
      this.log.firstElementChild?.remove();
    }
    if (stickToBottom) {
      this.log.scrollTop = this.log.scrollHeight;
    }
  }
}

/** One frame as a row: direction arrow + label + optional JSON tree. */
export function renderFrameRow(entry: FrameEntry): HTMLElement {
  const row = document.createElement("div");
  row.className = `wb-frame wb-frame-${entry.dir}`;
  const head = document.createElement("div");
  head.className = "wb-frame-head";
  const time = new Date(entry.at).toISOString().slice(11, 23);
  const size = entry.bytes !== undefined ? ` · ${entry.bytes} B` : "";
  head.textContent = `${entry.dir === "in" ? "→" : "←"} ${time}  ${entry.label}${size}`;
  row.append(head);
  if (entry.data !== undefined) {
    row.append(renderJsonTree(entry.data, { open: 1 }));
  }
  return row;
}
