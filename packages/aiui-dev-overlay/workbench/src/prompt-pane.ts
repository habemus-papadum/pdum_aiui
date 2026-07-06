/**
 * The Prompt pane: what *would* have reached the agent.
 *
 * The debug channel pushes every final lowered prompt back over the thread's
 * websocket (`lowered-prompt`) instead of delivering it to a session — this
 * pane collects those pushes off the shared {@link FramesFeed} and shows the
 * newest one full-size, with its Option-C meta as a JSON tree and the earlier
 * ones as a short history. This is the workbench's payoff view: the exact
 * text, end of pipeline, no agent triggered.
 */
import { renderJsonTree } from "@habemus-papadum/aiui-dev-overlay/debug-ui";
import { type FrameEntry, type FramesFeed, loweredPromptOf } from "./frames-feed";

interface LoweredPrompt {
  at: string;
  threadId: string;
  prompt: string;
  meta?: Record<string, string>;
}

export class PromptPane {
  readonly root: HTMLDivElement;
  private readonly current: HTMLDivElement;
  private readonly history: HTMLDivElement;
  private prompts: LoweredPrompt[] = [];
  private unsubscribe: (() => void) | undefined;

  constructor(private readonly feed: FramesFeed) {
    this.root = document.createElement("div");
    this.root.className = "wb-prompt";
    this.current = document.createElement("div");
    this.history = document.createElement("div");
    this.history.className = "wb-prompt-history";
    this.root.append(this.current, this.history);
    this.render();
  }

  activate(): void {
    if (this.unsubscribe) {
      return;
    }
    // Rebuild from scratch: subscribing replays the feed's full buffered
    // history (see FramesFeed), so prompts collected during a previous
    // activation would otherwise double up.
    this.prompts = [];
    this.render();
    this.unsubscribe = this.feed.subscribe((entries) => this.collect(entries));
  }

  deactivate(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  private collect(entries: FrameEntry[]): void {
    let changed = false;
    for (const entry of entries) {
      const lowered = loweredPromptOf(entry);
      if (lowered) {
        this.prompts.push({ at: entry.at, ...lowered });
        changed = true;
      }
    }
    if (changed) {
      this.prompts = this.prompts.slice(-20);
      this.render();
    }
  }

  private render(): void {
    this.current.replaceChildren();
    this.history.replaceChildren();
    const latest = this.prompts.at(-1);
    if (!latest) {
      const empty = document.createElement("div");
      empty.className = "wb-empty";
      empty.textContent =
        "no lowered prompt yet — send a turn (⏎) and the final prompt lands here instead of an agent";
      this.current.append(empty);
      return;
    }
    const head = document.createElement("div");
    head.className = "wb-prompt-head";
    head.textContent = `thread ${latest.threadId} · ${new Date(latest.at).toLocaleTimeString()}`;
    const text = document.createElement("pre");
    text.className = "wb-prompt-text";
    text.textContent = latest.prompt;
    this.current.append(head, text);
    if (latest.meta && Object.keys(latest.meta).length > 0) {
      const metaHead = document.createElement("div");
      metaHead.className = "wb-prompt-head";
      metaHead.textContent = "meta (attachments)";
      this.current.append(metaHead, renderJsonTree(latest.meta, { open: 1 }));
    }
    for (const prompt of this.prompts.slice(0, -1).reverse()) {
      const row = document.createElement("div");
      row.className = "wb-prompt-row";
      row.textContent = `${new Date(prompt.at).toLocaleTimeString()} · ${prompt.prompt.slice(0, 120)}`;
      this.history.append(row);
    }
  }
}
