/**
 * The Traces pane: the DevTools panel's Intent pane, re-hosted.
 *
 * Deliberately the same shared pieces the extension drives — a trace list over
 * `GET /debug/api/traces`, then `createTracePoll` + `TraceView` live-follow for
 * the selection — so any improvement to the shared debug-ui shows up here and
 * in DevTools at once, with only the list chrome (this file) workbench-local.
 *
 * Follow-newest is on by default: the workbench's whole point is watching the
 * turn you just spoke arrive, stage by stage, without ever touching a session.
 */
import { createTracePoll, TraceView } from "@habemus-papadum/aiui-dev-overlay/debug-ui";

interface TraceListEntry {
  id: string;
  format?: string;
  status?: string;
  startedAt?: string;
  actor?: string;
  /** The producing server's session label (absent on pre-upgrade traces). */
  session?: string;
}

export interface TracesPaneOptions {
  baseUrl: string;
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
  return {
    title: `${time} · ${entry.format ?? "?"}`,
    badges,
    dim: entry.status === "abandoned",
  };
}

/** The default list view: only the answering server's own traces. */
export function inSession(entry: TraceListEntry, currentSession?: string): boolean {
  return currentSession === undefined || entry.session === currentSession;
}

export class TracesPane {
  readonly root: HTMLDivElement;
  private readonly opts: TracesPaneOptions;
  private readonly fetchFn: typeof fetch;
  private readonly list: HTMLDivElement;
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
    this.fetchFn = opts.fetch ?? fetch;
    this.root = document.createElement("div");
    this.root.className = "wb-traces";

    const bar = document.createElement("div");
    bar.className = "wb-traces-bar";
    const followLabel = document.createElement("label");
    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = true;
    check.addEventListener("change", () => {
      this.follow = check.checked;
    });
    followLabel.append(check, document.createTextNode(" follow newest"));
    // Default: only this server's traces; the toggle reveals every session in
    // the cache, each badged with its producing session label.
    const allLabel = document.createElement("label");
    const all = document.createElement("input");
    all.type = "checkbox";
    all.addEventListener("change", () => {
      this.showAll = all.checked;
      this.renderList();
    });
    allLabel.append(all, document.createTextNode(" all sessions"));
    bar.append(followLabel, allLabel);

    this.list = document.createElement("div");
    this.list.className = "wb-trace-list";
    this.viewHost = document.createElement("div");
    this.viewHost.className = "wb-trace-view";
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
      this.session = payload.session;
    } catch {
      return; // channel starting/restarting — next tick retries
    }
    // Newest-first is the server's order; follow mode tracks the visible head.
    const visible = this.visibleEntries();
    if (this.follow && visible[0] && visible[0].id !== this.selectedId) {
      this.select(visible[0].id);
    }
    this.renderList();
  }

  private visibleEntries(): TraceListEntry[] {
    return this.showAll
      ? this.entries
      : this.entries.filter((entry) => inSession(entry, this.session));
  }

  private renderList(): void {
    this.list.replaceChildren();
    for (const entry of this.visibleEntries().slice(0, 40)) {
      const { title, badges, dim } = traceRowParts(entry, this.session);
      const row = document.createElement("button");
      row.type = "button";
      row.className = "wb-trace-row";
      row.classList.toggle("selected", entry.id === this.selectedId);
      row.classList.toggle("dim", dim);
      const text = document.createElement("span");
      text.textContent = title;
      row.append(text);
      for (const badge of badges) {
        const pill = document.createElement("span");
        pill.className = "wb-badge";
        pill.textContent = badge;
        row.append(pill);
      }
      row.addEventListener("click", () => {
        this.follow = false;
        const check = this.root.querySelector<HTMLInputElement>(".wb-traces-bar input");
        if (check) {
          check.checked = false;
        }
        this.select(entry.id);
        this.renderList();
      });
      this.list.append(row);
    }
    if (this.visibleEntries().length === 0) {
      const empty = document.createElement("div");
      empty.className = "wb-empty";
      empty.textContent =
        this.entries.length > 0
          ? "no traces from this session yet — check “all sessions” to see older ones"
          : "no traces yet — arm the overlay and speak a turn";
      this.list.append(empty);
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
