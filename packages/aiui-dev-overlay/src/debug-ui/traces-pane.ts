/**
 * The traces pane: the trace debugger's whole surface — a trace list over
 * `GET /debug/api/traces`, then `createTracePoll` + {@link TraceView}
 * live-follow for the selection.
 *
 * Graduated from the retired workbench lab so every
 * home of the trace debugger — the `/__aiui/debug` page the
 * Vite plugin serves (the intent tool's 🔍), and the DevTools extension —
 * renders traces off one implementation. Only page chrome stays host-local.
 *
 * Follow-newest is on by default: the debugger's whole point is watching the
 * turn you just spoke arrive, stage by stage. The list default-filters to the
 * *current session* — the answering server's own label, or the explicit
 * {@link TracesPaneOptions.session} pin (how a `?session=` deep link says
 * "this turn's session", even after the channel restarts under a new label).
 */

import { createTracePoll } from "./sources";
import { injectDebugUiStyles } from "./styles";
import { TraceView } from "./trace-view";

interface TraceListEntry {
  id: string;
  format?: string;
  status?: string;
  startedAt?: string;
  actor?: string;
  /** The producing server's session label (absent on pre-upgrade traces). */
  session?: string;
  /**
   * The one-line turn gloss the channel writes after the send (see the
   * channel's summarize.ts). When present it titles the row in place of the bare
   * format; it lands a beat after the trace (an async chat call), and the list's
   * 2s refresh picks it up.
   */
  summary?: string;
  /** The turn's model-spend roll-up in USD (channel cost.ts), when accounted. */
  costUsd?: number;
}

export interface TracesPaneOptions {
  baseUrl: string;
  /**
   * Pin the "current session" to this label instead of the answering server's
   * own — the `?session=` deep-link contract (the intent tool's 🔍 passes the
   * label of the channel it talked to).
   */
  session?: string;
  listIntervalMs?: number;
  followIntervalMs?: number;
  fetch?: typeof fetch;
}

/**
 * One trace-list row's text + badges; exported for tests. `currentSession` is
 * the answering server's own label — rows from *other* sessions (or unlabeled
 * pre-upgrade traces) get a session badge so they're tellable at a glance.
 */
export function traceRowParts(
  entry: TraceListEntry,
  currentSession?: string,
): {
  title: string;
  badges: string[];
  dim: boolean;
} {
  const time = entry.startedAt ? entry.startedAt.replace("T", " ").slice(5, 19) : entry.id;
  const badges: string[] = [];
  if (entry.actor && entry.actor !== "human") {
    badges.push(entry.actor);
  }
  if (entry.status === "abandoned") {
    badges.push("abandoned");
  }
  if (currentSession !== undefined && entry.session !== currentSession) {
    badges.push(entry.session ?? "unknown session");
  }
  // Prefer the turn gloss once it's landed — "18:52 · rewrite the beet essay"
  // reads far better than "18:52 · intent-v1" for a list of a dozen turns. The
  // spend roll-up tags along so a scan of the list is also a scan of the bill.
  const cost =
    entry.costUsd !== undefined && entry.costUsd > 0
      ? ` · ${entry.costUsd >= 0.01 ? `$${entry.costUsd.toFixed(2)}` : `$${entry.costUsd.toFixed(4)}`}`
      : "";
  return {
    title: `${time} · ${entry.summary ?? entry.format ?? "?"}${cost}`,
    badges,
    dim: entry.status === "abandoned",
  };
}

/** The default list view: only the current session's traces. */
export function inSession(entry: TraceListEntry, currentSession?: string): boolean {
  return currentSession === undefined || entry.session === currentSession;
}

export class TracesPane {
  readonly root: HTMLDivElement;
  private readonly opts: TracesPaneOptions;
  private readonly fetchFn: typeof fetch;
  private readonly list: HTMLSelectElement;
  private readonly viewHost: HTMLDivElement;
  private readonly view: TraceView;
  private entries: TraceListEntry[] = [];
  private session: string | undefined;
  private selectedId: string | undefined;
  private follow = true;
  private showAll = false;
  private listTimer: ReturnType<typeof setInterval> | undefined;
  private followTimer: ReturnType<typeof setInterval> | undefined;
  private poll: ReturnType<typeof createTracePoll> | undefined;

  constructor(opts: TracesPaneOptions) {
    this.opts = opts;
    this.session = opts.session;
    // Wrap, don't alias: `this.fetchFn(...)` would invoke a bare native fetch
    // with `this` = the pane — "Illegal invocation", swallowed by the poll's
    // catch, and the list stays empty forever.
    this.fetchFn = opts.fetch ?? ((input, init) => fetch(input, init));
    injectDebugUiStyles(document);
    this.root = document.createElement("div");
    this.root.className = "aiui-dbgt";

    const bar = document.createElement("div");
    bar.className = "aiui-dbgt-bar";
    const followLabel = document.createElement("label");
    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = true;
    check.addEventListener("change", () => {
      this.follow = check.checked;
    });
    followLabel.append(check, document.createTextNode(" follow newest"));
    // Default: only the current session's traces; the toggle reveals every
    // session in the cache, each badged with its producing session label.
    const allLabel = document.createElement("label");
    const all = document.createElement("input");
    all.type = "checkbox";
    all.addEventListener("change", () => {
      this.showAll = all.checked;
      this.renderList();
    });
    allLabel.append(all, document.createTextNode(" all sessions"));
    bar.append(followLabel, allLabel);

    // A dropdown, not a scrolling row list (reworked 2026-07-12): the picker
    // is a chooser, not content — one closed line, options on demand. Picking
    // a trace by hand naturally leaves follow mode.
    this.list = document.createElement("select");
    this.list.className = "aiui-dbgt-list";
    this.list.addEventListener("change", () => {
      const id = this.list.value;
      if (id === "") {
        return;
      }
      this.follow = false;
      const check = this.root.querySelector<HTMLInputElement>(".aiui-dbgt-bar input");
      if (check) {
        check.checked = false;
      }
      this.select(id);
    });
    this.viewHost = document.createElement("div");
    this.viewHost.className = "aiui-dbgt-view";
    this.view = new TraceView({
      blobUrl: (traceId, file) =>
        `${opts.baseUrl}/debug/blob/${encodeURIComponent(traceId)}/${encodeURIComponent(file)}`,
      previewUrl: (path) => `${opts.baseUrl}/debug/api/preview?path=${encodeURIComponent(path)}`,
    });
    this.viewHost.append(this.view.root);
    this.root.append(bar, this.list, this.viewHost);
  }

  activate(): void {
    if (!this.listTimer) {
      void this.refreshList();
      this.listTimer = setInterval(() => void this.refreshList(), this.opts.listIntervalMs ?? 2000);
    }
    if (!this.followTimer) {
      this.followTimer = setInterval(
        () => void this.tickSelected(),
        this.opts.followIntervalMs ?? 1500,
      );
    }
  }

  deactivate(): void {
    if (this.listTimer) {
      clearInterval(this.listTimer);
      this.listTimer = undefined;
    }
    if (this.followTimer) {
      clearInterval(this.followTimer);
      this.followTimer = undefined;
    }
  }

  private async refreshList(): Promise<void> {
    try {
      const res = await this.fetchFn(`${this.opts.baseUrl}/debug/api/traces`);
      if (!res.ok) {
        return;
      }
      const payload = (await res.json()) as { traces?: TraceListEntry[]; session?: string };
      this.entries = payload.traces ?? [];
      // An explicit pin (the ?session= deep link) beats the answering server's
      // own label — the link means "the session this turn came from".
      this.session = this.opts.session ?? payload.session;
    } catch {
      return; // channel starting/restarting — next tick retries
    }
    // Newest-first is the server's order; follow mode tracks the visible head.
    const visible = this.visibleEntries();
    if (this.follow && visible[0] && visible[0].id !== this.selectedId) {
      this.select(visible[0].id);
    }
    this.renderList(); // also re-asserts the dropdown's value (follow mode)
  }

  private visibleEntries(): TraceListEntry[] {
    return this.showAll
      ? this.entries
      : this.entries.filter((entry) => inSession(entry, this.session));
  }

  private renderList(): void {
    this.list.replaceChildren();
    const visible = this.visibleEntries().slice(0, 40);
    for (const entry of visible) {
      const { title, badges, dim } = traceRowParts(entry, this.session);
      const option = document.createElement("option");
      option.className = "aiui-dbgt-row";
      option.value = entry.id;
      option.textContent = badges.length > 0 ? `${title} · ${badges.join(" · ")}` : title;
      option.classList.toggle("dim", dim);
      if (badges.length > 0) {
        option.dataset.badges = badges.join(" ");
      }
      this.list.append(option);
    }
    if (visible.length === 0) {
      const empty = document.createElement("option");
      empty.value = "";
      empty.disabled = true;
      empty.selected = true;
      empty.textContent =
        this.entries.length > 0
          ? "no traces from this session yet — check “all sessions” to see older ones"
          : "no traces yet — arm the overlay and speak a turn";
      this.list.append(empty);
      return;
    }
    if (this.selectedId !== undefined) {
      this.list.value = this.selectedId;
    }
  }

  private select(id: string): void {
    this.selectedId = id;
    this.poll = createTracePoll({
      baseUrl: this.opts.baseUrl,
      traceId: id,
      ...(this.opts.fetch !== undefined ? { fetch: this.opts.fetch } : {}),
    });
    this.view.update(undefined);
    void this.tickSelected();
  }

  private async tickSelected(): Promise<void> {
    if (!this.poll) {
      return;
    }
    const result = await this.poll.poll();
    if (result.changed && result.trace) {
      this.view.update(result.trace);
    }
  }
}
