/**
 * The page-tool directory: the channel's registry of tools that live *in the
 * browser*.
 *
 * A dev page (via the intent client's tools-link, relaying the page's own
 * `window.__AIUI__.tools`) opens a websocket to the channel's `/tools`
 * endpoint and declares the tools it exposes — name, description, JSON Schema
 * — for the whole namespace at once. The channel keeps that declaration here;
 * the MCP layer surfaces it to the Claude Code session (`page_tools_list`),
 * and a call (`page_tools_call`) is routed back over the same socket to the
 * live page function, whose result returns the same way.
 *
 * **The directory is a routing table, not an event source** (the
 * channel-wakeups decision, 2026-09-15). It never announces that its contents
 * changed — no session push, no `tools/list_changed` — because every such
 * announcement became a model turn over the whole context, fired by nothing
 * more than the user (or the agent's own verification loop) opening and
 * closing tabs. The agent asks when it has a question: `list()` answers it,
 * addressed by TAB. Registrations carry each host's honest tab record (the
 * extension's chrome ids; the plain-page CDP host's target id + driver tab),
 * and a call names the tab it means with any of those ids or the page URL.
 * Tab `activation` (which tab the user is looking at) is still tracked —
 * flag-only, so a CLI-initiated turn can find "the page in view" — and it
 * breaks ties for an un-addressed call; it announces nothing either.
 *
 * This module is transport-agnostic — a connection is just an id plus a `send`
 * function — so the whole thing is unit-testable without a real websocket (see
 * page-tools.test.ts). web.ts wires it to the `/tools` websocket; the wire
 * protocol is documented in docs/websocket-protocol.md.
 *
 * Nothing here may write to stdout: in the `mcp` command that stream carries the
 * MCP stdio protocol. The registration log line goes through {@link
 * PageToolDirectoryOptions.log}, which defaults to stderr.
 */
import { randomUUID } from "node:crypto";
import type { SourceInfo, TabInfo } from "./frame";

/** One tool a page declares: MCP-shaped, no implementing function (that stays in the page). */
export interface PageToolDescriptor {
  name: string;
  description: string;
  /** How to use it: when to call it, what the result means, an example — the
   * tool-docs convention (aiui-viz `AgentTool.usage`). */
  usage?: string;
  /** Eagerness class: `read` is called freely once the intent is clear,
   * `write` changes the app (aiui-viz `AgentTool.kind`). */
  kind?: "read" | "write";
  /** JSON Schema (draft 2020-12 object schema) for the tool's arguments. */
  inputSchema?: Record<string, unknown>;
}

/**
 * The tab record a registration carries: url/title plus whichever ids the
 * registering HOST honestly has. The browser extension knows `chromeTabId` /
 * `windowId` / `tabIndex`; the plain-page CDP host knows the CDP `targetId`
 * and its own `driverTab` handle. Never both — and none of them is the Chrome
 * DevTools MCP's `pageId` (that one exists only in `list_pages` output; the
 * join is by url/title).
 */
export type PageToolTab = TabInfo & {
  /** The plain-page host's CDP driver handle for this tab. */
  driverTab?: number;
};

/** The id fields two tab records can be compared on (never url — two tabs may share one). */
const TAB_ID_KEYS = ["chromeTabId", "targetId", "driverTab"] as const;

/** Whether two tab records name the same tab: any id present in BOTH is equal. */
function sameTab(a: PageToolTab | undefined, b: PageToolTab | undefined): boolean {
  if (!a || !b) {
    return false;
  }
  return TAB_ID_KEYS.some((key) => a[key] !== undefined && a[key] === b[key]);
}

/**
 * How the agent names a tab. Any field narrows; all given fields must hold.
 * The ids are copied from the prompt's `<tab …/>` marker (`chrome-tab-id`,
 * `cdp-target-id`, `driver-tab`) or from a previous `list()`; `url` is the
 * page's `location.href` — an exact match wins, else a prefix match (so the
 * URL `list_pages` prints, or the app's origin, both work).
 */
export interface TabSelector {
  chromeTabId?: number;
  targetId?: string;
  driverTab?: number;
  url?: string;
}

/** A page's declaration of the full tool set for one namespace. */
export interface PageToolRegistration {
  /** Server-assigned id of the connection this namespace was declared on. */
  clientId: string;
  /** The page namespace (`morpho`, `aztec`, …); unique per connection. */
  ns: string;
  /** The page's live `location.href` (updated by the client on navigation). */
  url?: string;
  /** The browser tab the page lives in — the registering host's honest record. */
  tab?: PageToolTab;
  /** Where the page's source lives on disk. */
  source?: SourceInfo;
  /** Content hash of the tool set (page-computed) — identity across reloads. */
  hash: string;
  /** The declared tools. */
  tools: PageToolDescriptor[];
  /** The kit's brief: what the app is and how its tools relate — read it
   * before driving the app. */
  brief?: string;
  /** ISO timestamp of the (latest) registration. */
  registeredAt: string;
  /**
   * The NAMESPACE's activity bit (the page-tools proposal, git history): false when
   * the page parked this app (a gallery notebook off-route). Parked tools
   * stay listed and callable — the agent sees the flag; route-following
   * consumers (the panel's oracle) filter page-side.
   */
  active: boolean;
  /**
   * Present when this registration's tab is a window's active tab (per the
   * `activation` messages — see {@link PageToolDirectory.handleClientMessage}).
   * Derived at {@link PageToolDirectory.list} time, never stored.
   */
  activeTab?: true;
  /**
   * Derived at {@link PageToolDirectory.list} time: this registration's
   * namespace collides with another connection's, and an UN-ADDRESSED call
   * would pick the OTHER one. Advisory — name the tab and it is moot.
   */
  shadowed?: true;
}

/** One connected tab as the agent sees it: its record plus every namespace it holds. */
export interface PageToolTabEntry {
  clientId: string;
  url?: string;
  tab?: PageToolTab;
  source?: SourceInfo;
  /** True when the user is looking at this tab (when the client reports activation). */
  activeTab?: true;
  namespaces: Array<{
    ns: string;
    hash: string;
    active: boolean;
    shadowed?: true;
    /** The kit's brief — read it before driving the app. */
    brief?: string;
    tools: PageToolDescriptor[];
  }>;
}

/** A call the agent asks the directory to route to a page. */
export interface PageToolCall {
  /** Which tab (any of its ids, or its url). Omit only when one page is connected. */
  tab?: TabSelector;
  /** Disambiguator: which connection (an exact handle from `list()`). */
  clientId?: string;
  /** Disambiguator: which namespace, when a tab holds several. */
  ns?: string;
  /** The tool to call. */
  name: string;
  /** Arguments (must satisfy the tool's `inputSchema`); passed through as-is. */
  args?: unknown;
  /** How long to wait for the page's result before rejecting (default 15s). */
  timeoutMs?: number;
}

/** A message the server sends down a page connection. */
export type ServerToClientMessage =
  | { v: 1; type: "call"; callId: string; ns: string; name: string; args?: unknown }
  | { v: 1; type: "registered"; ns: string; hash: string };

/** How the directory pushes a message to one connection. */
export type PageToolSend = (message: ServerToClientMessage) => void;

/** A cheap count summary of the directory, for `/health`/`/debug`. */
export interface PageToolSummary {
  /** Open page connections. */
  clients: number;
  /** Registered (connection, namespace) pairs. */
  namespaces: number;
  /** Total declared tools across all namespaces. */
  tools: number;
}

export interface PageToolDirectoryOptions {
  /**
   * Where the registration log line goes (a namespace registering a *new*
   * tool-set hash — reloads with an unchanged set are silent). Defaults to
   * stderr, since stdout carries the MCP protocol. Inject a collector in tests.
   */
  log?: (line: string) => void;
  /** Clock for `registeredAt` — inject for deterministic tests. */
  now?: () => Date;
  /** Id generator for client ids and call ids — inject for deterministic tests. */
  newId?: () => string;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Connection {
  clientId: string;
  send: PageToolSend;
  /** The namespaces this connection has declared, keyed by ns. */
  registrations: Map<string, PageToolRegistration>;
  /** In-flight calls awaiting a `result`, keyed by callId. */
  pending: Map<string, Pending>;
}

const DEFAULT_TIMEOUT_MS = 15_000;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;

/** Read a tab record off the wire: only the fields we know, each type-checked. */
function readTab(value: unknown): PageToolTab | undefined {
  const raw = asRecord(value);
  if (!raw) {
    return undefined;
  }
  const tab: PageToolTab = {};
  if (typeof raw.url === "string") {
    tab.url = raw.url;
  }
  if (typeof raw.title === "string") {
    tab.title = raw.title;
  }
  if (typeof raw.chromeTabId === "number") {
    tab.chromeTabId = raw.chromeTabId;
  }
  if (typeof raw.windowId === "number") {
    tab.windowId = raw.windowId;
  }
  if (typeof raw.tabIndex === "number") {
    tab.tabIndex = raw.tabIndex;
  }
  if (typeof raw.targetId === "string") {
    tab.targetId = raw.targetId;
  }
  if (typeof raw.driverTab === "number") {
    tab.driverTab = raw.driverTab;
  }
  return tab;
}

/** A selector with no criteria narrows nothing. */
const selectorIsEmpty = (sel: TabSelector | undefined): boolean =>
  sel === undefined ||
  (sel.chromeTabId === undefined &&
    sel.targetId === undefined &&
    sel.driverTab === undefined &&
    sel.url === undefined);

/** Render a selector for an error message. */
const describeSelector = (sel: TabSelector): string => JSON.stringify(sel);

/**
 * The channel's live registry of page-declared tools and the connections that
 * back them. One instance per channel process; shared by the `/tools`
 * websocket (which feeds it) and the MCP tools (which read and drive it).
 */
export class PageToolDirectory {
  private readonly connections = new Map<string, Connection>();
  private readonly log: (line: string) => void;
  private readonly now: () => Date;
  private readonly newId: () => string;
  /**
   * The browser's active tab per window (`windowId` → tab record), fed by
   * `activation` messages. Directory-global, not per connection: whichever
   * socket reports it (the intent client's tools-link), there is one truth about
   * which tab a window shows. Empty until an activation arrives — every
   * active-tab behavior degrades to the flag simply being absent.
   */
  private readonly activeTabs = new Map<number, PageToolTab>();

  constructor(options: PageToolDirectoryOptions = {}) {
    this.log = options.log ?? ((line) => process.stderr.write(`${line}\n`));
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? randomUUID;
  }

  /** Register a freshly connected page socket; returns its server-assigned id. */
  addConnection(send: PageToolSend): string {
    const clientId = this.newId();
    this.connections.set(clientId, {
      clientId,
      send,
      registrations: new Map(),
      pending: new Map(),
    });
    return clientId;
  }

  /**
   * Drop a connection: forget its namespaces and reject any in-flight calls.
   * Called when the socket closes.
   */
  removeConnection(clientId: string): void {
    const conn = this.connections.get(clientId);
    if (!conn) {
      return;
    }
    for (const pending of conn.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("page disconnected before the tool call returned"));
    }
    this.connections.delete(clientId);
  }

  /**
   * Dispatch one parsed client message (a `register`, a `result`, or an
   * `activation`). Validates loosely — a malformed message is ignored rather
   * than fatal, since the transport is a cooperative same-host client.
   */
  handleClientMessage(clientId: string, raw: unknown): void {
    const msg = asRecord(raw);
    if (!msg) {
      return;
    }
    if (msg.type === "register") {
      this.register(clientId, msg);
    } else if (msg.type === "result" && typeof msg.callId === "string") {
      this.settle(clientId, msg.callId, msg);
    } else if (msg.type === "activation") {
      this.activation(msg);
    }
  }

  /**
   * Track the browser's active tab. The message (sent by the intent client's
   * tools-link over `/tools`) carries which tab just became — or stopped
   * being — its window's active tab, as a tab record in the sender's own id
   * namespace. Never receiving one is fine: the directory simply reports no
   * `activeTab` flags. Deliberately announces nothing: a tab switch is not an
   * event the agent needs to hear about.
   */
  private activation(msg: Record<string, unknown>): void {
    const tab = readTab(msg.tab);
    if (!tab || typeof msg.active !== "boolean") {
      return;
    }
    if (!TAB_ID_KEYS.some((key) => tab[key] !== undefined)) {
      return; // a record with no id can neither activate nor deactivate anything
    }
    // One active tab per window; a sender that omits windowId shares a single
    // bucket (still exactly one active tab overall — coherent, just coarser).
    const windowId = tab.windowId ?? -1;
    if (msg.active) {
      this.activeTabs.set(windowId, tab);
    } else if (sameTab(this.activeTabs.get(windowId), tab)) {
      // Only the currently-active tab may deactivate its window — a stale
      // deactivation must not clobber a newer activation.
      this.activeTabs.delete(windowId);
    }
  }

  /** Whether a registration's page sits in some window's active tab. */
  private isActive(reg: PageToolRegistration): boolean {
    for (const active of this.activeTabs.values()) {
      if (sameTab(active, reg.tab)) {
        return true;
      }
    }
    return false;
  }

  private register(clientId: string, msg: Record<string, unknown>): void {
    const conn = this.connections.get(clientId);
    if (!conn || typeof msg.ns !== "string" || !Array.isArray(msg.tools)) {
      return;
    }
    const tools: PageToolDescriptor[] = msg.tools
      .map(asRecord)
      .filter((t): t is Record<string, unknown> => !!t && typeof t.name === "string")
      .map((t) => ({
        name: t.name as string,
        description: typeof t.description === "string" ? t.description : "",
        ...(typeof t.usage === "string" ? { usage: t.usage } : {}),
        ...(t.kind === "read" || t.kind === "write" ? { kind: t.kind } : {}),
        ...(asRecord(t.inputSchema) ? { inputSchema: asRecord(t.inputSchema) } : {}),
      }));
    const hash = typeof msg.hash === "string" ? msg.hash : "";
    const previous = conn.registrations.get(msg.ns);
    const tab = readTab(msg.tab);
    const entry: PageToolRegistration = {
      clientId,
      ns: msg.ns,
      ...(typeof msg.url === "string" ? { url: msg.url } : {}),
      ...(tab ? { tab } : {}),
      ...(asRecord(msg.source) ? { source: asRecord(msg.source) as SourceInfo } : {}),
      hash,
      tools,
      ...(typeof msg.brief === "string" ? { brief: msg.brief } : {}),
      // Absent on registrations from links predating the bit ⇒ active.
      active: msg.active !== false,
      registeredAt: this.now().toISOString(),
    };
    conn.registrations.set(msg.ns, entry);
    // Only a real change to the tool set is worth a line — HMR/reload
    // re-registrations carry the same hash and stay silent.
    if (!previous || previous.hash !== hash) {
      this.log(
        `page-tools: ${msg.ns} declared ${tools.length} tool(s) [${hash}]` +
          (entry.url ? ` from ${entry.url}` : ""),
      );
    }
    conn.send({ v: 1, type: "registered", ns: msg.ns, hash });
  }

  private settle(clientId: string, callId: string, msg: Record<string, unknown>): void {
    const conn = this.connections.get(clientId);
    const pending = conn?.pending.get(callId);
    if (!conn || !pending) {
      return;
    }
    conn.pending.delete(callId);
    clearTimeout(pending.timer);
    if (msg.ok === true) {
      pending.resolve(msg.value);
    } else {
      pending.reject(
        new Error(typeof msg.error === "string" ? msg.error : "page tool call failed"),
      );
    }
  }

  /**
   * Rank two same-namespace registrations for un-addressed routing: the user's
   * eye first (a window's active tab), then a live (non-parked) namespace over
   * a parked one, then the newer registration. Shared by the shadow marking in
   * {@link list} and the tie-break in {@link call}, so the list's marks and
   * the router's choice cannot disagree.
   */
  private preferable(a: PageToolRegistration, b: PageToolRegistration): PageToolRegistration {
    const eyeA = this.isActive(a);
    if (eyeA !== this.isActive(b)) {
      return eyeA ? a : b;
    }
    if (a.active !== b.active) {
      return a.active ? a : b;
    }
    return a.registeredAt >= b.registeredAt ? a : b;
  }

  /**
   * Whether a registration is on the tab a selector names. Every given field
   * must hold; `url` matches the registration's live url exactly or by prefix
   * (exact matches are preferred by the caller — see {@link select}).
   */
  private matchesTab(
    reg: PageToolRegistration,
    sel: TabSelector,
    urlMode: "exact" | "prefix",
  ): boolean {
    const tab = reg.tab;
    if (sel.chromeTabId !== undefined && tab?.chromeTabId !== sel.chromeTabId) {
      return false;
    }
    if (sel.targetId !== undefined && tab?.targetId !== sel.targetId) {
      return false;
    }
    if (sel.driverTab !== undefined && tab?.driverTab !== sel.driverTab) {
      return false;
    }
    if (sel.url !== undefined) {
      const url = reg.url ?? tab?.url;
      if (url === undefined) {
        return false;
      }
      if (urlMode === "exact" ? url !== sel.url : !url.startsWith(sel.url)) {
        return false;
      }
    }
    return true;
  }

  /**
   * The registrations a selector picks out of a candidate set. A url that
   * matches some candidate EXACTLY restricts to exact matches; otherwise a
   * prefix match stands (the app's origin, or a url `list_pages` printed
   * before the page navigated within it).
   */
  private select(
    candidates: PageToolRegistration[],
    sel: TabSelector | undefined,
  ): PageToolRegistration[] {
    if (selectorIsEmpty(sel) || sel === undefined) {
      return candidates;
    }
    const exact = candidates.filter((reg) => this.matchesTab(reg, sel, "exact"));
    if (exact.length > 0 || sel.url === undefined) {
      return exact;
    }
    return candidates.filter((reg) => this.matchesTab(reg, sel, "prefix"));
  }

  /**
   * Every current registration, across all connections, or only those on the
   * tab a selector names — active-tab entries first (stable within each
   * group). When two connections carry the SAME namespace, the losers are
   * marked `shadowed`: the honest rendering of a duplicate — an un-addressed
   * call would go to the winner.
   */
  list(selector?: TabSelector & { clientId?: string }): PageToolRegistration[] {
    const out: PageToolRegistration[] = [];
    const winners = new Map<string, PageToolRegistration>();
    for (const conn of this.connections.values()) {
      for (const reg of conn.registrations.values()) {
        // Shallow copies, so the derived flags never leak into stored state.
        const copy: PageToolRegistration = this.isActive(reg)
          ? { ...reg, activeTab: true }
          : { ...reg };
        out.push(copy);
        const rival = winners.get(reg.ns);
        winners.set(reg.ns, rival === undefined ? copy : this.preferable(rival, copy));
      }
    }
    for (const reg of out) {
      if (winners.get(reg.ns) !== reg) {
        reg.shadowed = true;
      }
    }
    const byClient =
      selector?.clientId !== undefined
        ? out.filter((reg) => reg.clientId === selector.clientId)
        : out;
    return this.select(byClient, selector).sort(
      (a, b) => Number(b.activeTab === true) - Number(a.activeTab === true),
    );
  }

  /**
   * The same directory grouped by TAB — what `page_tools_list` serves: one
   * entry per connected tab (a connection is a tab; the intent client dials
   * one socket per tab that has tools), carrying the tab record the agent
   * addresses calls with, and every namespace the tab holds.
   */
  tabs(selector?: TabSelector & { clientId?: string }): PageToolTabEntry[] {
    const entries = new Map<string, PageToolTabEntry>();
    for (const reg of this.list(selector)) {
      let entry = entries.get(reg.clientId);
      if (!entry) {
        entry = {
          clientId: reg.clientId,
          ...(reg.url !== undefined ? { url: reg.url } : {}),
          ...(reg.tab !== undefined ? { tab: reg.tab } : {}),
          ...(reg.source !== undefined ? { source: reg.source } : {}),
          ...(reg.activeTab ? { activeTab: true } : {}),
          namespaces: [],
        };
        entries.set(reg.clientId, entry);
      }
      entry.namespaces.push({
        ns: reg.ns,
        hash: reg.hash,
        active: reg.active,
        ...(reg.shadowed ? { shadowed: true } : {}),
        ...(reg.brief !== undefined ? { brief: reg.brief } : {}),
        tools: reg.tools,
      });
    }
    return [...entries.values()];
  }

  /** Cheap counts for a `/health` or `/debug` summary. */
  summary(): PageToolSummary {
    let namespaces = 0;
    let tools = 0;
    for (const conn of this.connections.values()) {
      for (const reg of conn.registrations.values()) {
        namespaces += 1;
        tools += reg.tools.length;
      }
    }
    return { clients: this.connections.size, namespaces, tools };
  }

  /** A short, agent-readable identifier for a candidate registration. */
  private describeCandidate(reg: PageToolRegistration): string {
    const tab = reg.tab;
    return JSON.stringify({
      clientId: reg.clientId,
      ns: reg.ns,
      ...(reg.url ? { url: reg.url } : {}),
      ...(tab?.title ? { title: tab.title } : {}),
      ...(tab?.chromeTabId !== undefined ? { chromeTabId: tab.chromeTabId } : {}),
      ...(tab?.targetId !== undefined ? { targetId: tab.targetId } : {}),
      ...(tab?.driverTab !== undefined ? { driverTab: tab.driverTab } : {}),
      ...(this.isActive(reg) ? { activeTab: true } : {}),
      ...(reg.active ? {} : { parked: true }),
    });
  }

  /** One line naming every connected tab, for "no such tab" errors. */
  private describeTabs(): string {
    const seen = new Set<string>();
    const parts: string[] = [];
    for (const conn of this.connections.values()) {
      for (const reg of conn.registrations.values()) {
        if (seen.has(reg.clientId)) {
          continue;
        }
        seen.add(reg.clientId);
        parts.push(this.describeCandidate(reg));
      }
    }
    return parts.join(", ");
  }

  /**
   * Route a call to the one page registration that matches. The tab selector,
   * `clientId`, and `ns` each narrow; among several matches a single one on the
   * browser's active tab wins, then a single live (non-parked) one. Rejects on
   * remaining ambiguity (listing the candidates), when nothing matches, on
   * timeout, or if the page disconnects before answering.
   */
  call(request: PageToolCall): Promise<unknown> {
    const { tab, clientId, ns, name, args, timeoutMs = DEFAULT_TIMEOUT_MS } = request;
    if (this.connections.size === 0) {
      return Promise.reject(new Error(`no page connected — cannot call tool "${name}"`));
    }
    const all: PageToolRegistration[] = [];
    for (const conn of this.connections.values()) {
      if (clientId !== undefined && conn.clientId !== clientId) {
        continue;
      }
      for (const reg of conn.registrations.values()) {
        if (ns === undefined || reg.ns === ns) {
          all.push(reg);
        }
      }
    }
    const onTab = this.select(all, tab);
    if (onTab.length === 0 && tab !== undefined && !selectorIsEmpty(tab)) {
      const known = this.describeTabs();
      return Promise.reject(
        new Error(
          `no connected page matches tab ${describeSelector(tab)}` +
            (known ? ` — connected: ${known}` : " — no page has registered tools"),
        ),
      );
    }
    let candidates = onTab.filter((reg) => reg.tools.some((t) => t.name === name));
    if (candidates.length > 1) {
      // Active-tab preference resolves cross-tab ambiguity only when it picks
      // exactly one candidate; two active matches (two namespaces in one tab)
      // or none fall through to the next narrowing.
      const active = candidates.filter((reg) => this.isActive(reg));
      if (active.length === 1) {
        candidates = active;
      }
    }
    if (candidates.length > 1) {
      // Then a LIVE namespace beats a parked one (the gallery: the notebook
      // in view over its off-route twin) — again only when that is decisive.
      const live = candidates.filter((reg) => reg.active);
      if (live.length === 1) {
        candidates = live;
      }
    }

    if (candidates.length === 0) {
      const known = onTab.flatMap((reg) => reg.tools.map((t) => `${reg.ns}/${t.name}`)).join(", ");
      return Promise.reject(
        new Error(
          `no page tool "${name}"${ns !== undefined ? ` in namespace "${ns}"` : ""} is registered` +
            (tab !== undefined && !selectorIsEmpty(tab) ? ` on tab ${describeSelector(tab)}` : "") +
            (known ? ` (available: ${known})` : ""),
        ),
      );
    }
    if (candidates.length > 1) {
      const list = candidates.map((reg) => this.describeCandidate(reg)).join(", ");
      return Promise.reject(
        new Error(
          `ambiguous tool "${name}" — ${candidates.length} registrations match; ` +
            `name the tab (chromeTabId / targetId / driverTab / url) and/or ns. Candidates: ${list}`,
        ),
      );
    }

    const reg = candidates[0];
    const conn = this.connections.get(reg.clientId);
    if (!conn) {
      return Promise.reject(new Error("page disconnected before the tool call was sent"));
    }
    const callId = this.newId();
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.pending.delete(callId);
        reject(new Error(`page tool "${reg.ns}/${name}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      // Don't let a pending call keep the process alive on its own.
      if (typeof timer === "object" && "unref" in timer) {
        timer.unref();
      }
      conn.pending.set(callId, { resolve, reject, timer });
      try {
        conn.send({
          v: 1,
          type: "call",
          callId,
          ns: reg.ns,
          name,
          ...(args !== undefined ? { args } : {}),
        });
      } catch (err) {
        clearTimeout(timer);
        conn.pending.delete(callId);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }
}
