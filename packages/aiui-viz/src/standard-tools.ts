/**
 * standard-tools.ts — the derived agent interface: the tools every aiui app
 * gets from its declarations, so nobody hand-writes `get-params`/`set-params`
 * boilerplate (the extraction that motivated the control surface — see the
 * front-end controls design notes, git history).
 *
 * From one `registerStandardTools(kit)` call an app's agent surface is
 * ASSEMBLED from the reflection layer — restricted to the KIT'S VIEW of the
 * global registries (its own scope subtree + unscoped declarations, plus any
 * `scopes` the caller declares — see {@link surfaceViewFor}; the reason: a
 * multi-app document like the gallery must not cross-pollinate kits):
 *
 *  - `report` — the whole picture in one call: controls (+values), cells
 *    (+states), actions, dependency edges, plus the app's custom reporter
 *    sections. `format: "brief"` (default) is the token-frugal map view;
 *    `"full"` adds descriptions, definition sites, constraint metadata, and
 *    settledness — everything the registries know.
 *  - `set` — one generic writer for every control, validating through the
 *    control's OWN meta (clamp/snap/enum/type live in control.ts, in one
 *    place). Returns what was written, never a re-read: Solid batches writes,
 *    so a same-tick read would lie.
 *  - **one real tool per `action()`** — each registered verb surfaces under
 *    its own name with its own description and schema (the reason actions
 *    carry descriptions at all). Actions declared AFTER registration are
 *    picked up through the control-surface subscription, so declaration order
 *    never matters.
 *  - `locate` — element → source/cell stamps, unchanged.
 *  - `read-page` — the page as text (page-text.ts): headings, prose, lists,
 *    tables, every equation as its TeX; windowed, so a long page is paged.
 *  - `selection` — what the user has selected (page-selection.ts): the text,
 *    the TeX, the authoring elements and producing cells with their source
 *    locations — every `file` exactly what `source` takes.
 *  - `sources` — the files this page can read (source-reader.ts): the dev
 *    server's workspace, or what a build shipped; says plainly when there
 *    are none.
 *  - `source` — one of those files by its stamp path, as numbered lines; a
 *    file the page cannot read answers `{ available: false, reason }` with
 *    the nearest names it can.
 *
 * Kept out of agent-tools.ts so that module stays dependency-free; kept
 * explicit (one line, not automatic) so a headless app can opt out and tests
 * can construct toolkits without a DOM.
 */

import type { AgentTool, AgentToolkit } from "./agent-tools";
import { bridgeRegistry } from "./bridge-effect";
import { cellRegistry } from "./cell";
import { actionByName, controlByName, controlSurface, subscribeControlSurface } from "./control";
import { dependencyEdges } from "./graph-trace";
import {
  pageSelection,
  SELECTION_DEFAULT_CHARS,
  SELECTION_DEFAULT_DEPTH,
  SELECTION_MAX_CHARS,
  SELECTION_MAX_DEPTH,
} from "./page-selection";
import { pageText, READ_PAGE_DEFAULT_CHARS, READ_PAGE_MAX_CHARS } from "./page-text";
import type { Scope } from "./scope";
import {
  listSources,
  readSource,
  SOURCE_DEFAULT_LINES,
  SourceUnavailableError,
} from "./source-reader";

/** How many files `sources` lists when `limit` is not given. */
const SOURCES_DEFAULT_LIMIT = 200;

/** How many elements `locate` will describe in one call. */
const LOCATE_LIMIT = 20;

/** Options for {@link registerStandardTools}. */
export interface StandardToolsOptions {
  /**
   * Extra scopes this kit SERVES, beyond its default view (see
   * {@link surfaceViewFor}) — the composition escape hatch. The twins shape: a
   * kit named `app` hosting slices scoped `left`/`right` declares them here,
   * and their actions surface as `left/kick` / `right/kick`. Accepts Scope
   * objects or bare scope names.
   */
  scopes?: readonly (Scope | string)[];
}

/**
 * One scope's VIEW of the global registries: which declarations belong to it.
 * See {@link surfaceViewFor} for the membership rule.
 */
export interface SurfaceView {
  /** The scopes this view serves — the owning scope first, then any extras. */
  readonly scopes: readonly string[];
  /** Does the declaration registered under this (scope-qualified) name belong
   * to the view? */
  owns(name: string): boolean;
}

/**
 * The membership test for one scope's slice of the global registries — the
 * SINGLE definition of "a surface", shared by the toolkit's standard tools
 * (below) and by aiui-oracle's control-surface projection, so a scoped oracle
 * and the equivalent kit never disagree about what an app's surface is.
 *
 * A view serves its own scope subtree (`ns/…`) plus UNSCOPED declarations
 * (a single-app document's common case: an app whose declarations carry no
 * scope still gets its own tools); `extraScopes` declares more (composition —
 * the twins shape). A multi-app document (the gallery: N kits, N scopes) is
 * the reason this exists at all — a kit iterating the whole global surface
 * registered every app's actions on every kit (M×N contamination, found live
 * 2026-08-03).
 *
 * Membership reads off the QUALIFIED NAME, which control.ts makes the identity
 * of every declaration. Entries that also carry a `scope` field agree by
 * construction — `control()`/`action()` build the name as `<scope>/<leaf>`, so
 * name-prefix and scope-prefix ownership coincide — and reading the name is
 * what lets the same rule cover cells, dependency edges and bridges, whose
 * snapshots carry no scope field at all.
 */
export function surfaceViewFor(
  ns: string,
  extraScopes: readonly (Scope | string)[] = [],
): SurfaceView {
  const scopes = [ns, ...extraScopes.map((s) => (typeof s === "string" ? s : s.name))];
  return {
    scopes,
    owns: (name) =>
      !name.includes("/") // unqualified = unscoped = belongs everywhere
        ? true
        : scopes.some((p) => name.startsWith(`${p}/`)),
  };
}

/** The `report` tool's payload for one format — the KIT's view, not the
 * document's: in a multi-app document, aztec's report must not narrate
 * gears' controls. */
function buildReport(
  kit: AgentToolkit,
  view: SurfaceView,
  format: "brief" | "full",
): Record<string, unknown> {
  const surface = controlSurface().filter((e) => view.owns(e.name));
  const cells = cellRegistry().filter((c) => view.owns(c.name));
  const edges = dependencyEdges().filter((e) => view.owns(e.cell));
  const bridges = bridgeRegistry().filter((b) => view.owns(b.name));

  if (format === "brief") {
    return {
      controls: Object.fromEntries(
        surface.filter((e) => e.kind === "control").map((e) => [e.name, e.value]),
      ),
      actions: surface.filter((e) => e.kind === "action").map((e) => e.name),
      cells: Object.fromEntries(cells.map((c) => [c.name, c.state])),
      // "kappa ← profile" reading: which registered nodes each cell's deps read.
      edges: Object.fromEntries(
        edges.map((e) => [e.cell, e.reads.map((r) => `${r.kind}:${r.name}`)]),
      ),
      // Airlocks into imperative systems (bridgeEffect): a failed crossing is
      // recorded here rather than thrown, so this line is where it surfaces.
      // Omitted entirely when the app declares no named bridges.
      ...(bridges.length
        ? {
            bridges: Object.fromEntries(
              bridges.map((b) => [
                b.name,
                b.errorCount === 0 ? "ok" : `error×${b.errorCount}: ${b.lastError}`,
              ]),
            ),
          }
        : {}),
      ...custom(kit),
    };
  }
  return {
    controls: surface.filter((e) => e.kind === "control"),
    actions: surface.filter((e) => e.kind === "action"),
    cells,
    edges,
    ...(bridges.length ? { bridges } : {}),
    ...custom(kit),
  };
}

/** The app's own reporter sections (minus ours — they'd double-report). */
function custom(kit: AgentToolkit): Record<string, unknown> {
  const ours = new Set(["cells", "bridges"]);
  const out: Record<string, unknown> = {};
  for (const [name, reporter] of kit.handle().reporters) {
    if (ours.has(name)) continue;
    try {
      out[name] = reporter();
    } catch (err) {
      out[name] = { error: String(err) };
    }
  }
  return out;
}

/**
 * An action, dressed as the agent tool it becomes. `toolName` is the action's
 * identity RELATIVE to the kit (see {@link kitRelativeName}); `name` stays the
 * registry's fully-qualified identity, which the run stays late-bound through.
 */
function toolOfAction(name: string, toolName: string): AgentTool | undefined {
  const a = actionByName(name);
  if (!a) return undefined;
  return {
    name: toolName,
    description: a.description ?? `Run the app's "${a.name}" action.`,
    ...(a.usage !== undefined ? { usage: a.usage } : {}),
    // An action changes the app unless it says otherwise.
    kind: a.kind ?? "write",
    ...(a.params !== undefined ? { params: a.params } : {}),
    ...(a.inputSchema !== undefined ? { inputSchema: a.inputSchema } : {}),
    // Late-bound through the registry so an HMR re-declaration swaps the
    // implementation without re-registering the tool.
    run: (args) => {
      const live = actionByName(name);
      if (!live) throw new Error(`action "${name}" is no longer registered`);
      return live.run(args);
    },
  };
}

/**
 * A tool's name inside a kit is its identity relative to that kit. An action's
 * registry name is scope-qualified (`testapp/reseed`), and the shared registry
 * republishes every kit tool under `<ns>/<tool>` — so for the common app shape
 * (kit ns == app scope) keeping the qualified name would double the prefix
 * (`testapp/testapp/reseed` on the channel). Strip the kit's namespace when
 * the action's SCOPE sits inside it; a foreign-scoped action keeps its
 * qualified name, so a kit `app` hosting slices `left`/`right` still exposes
 * distinguishable `app/left/reseed` / `app/right/reseed`.
 */
function kitRelativeName(kit: AgentToolkit, name: string, scope: string | undefined): string {
  if (scope === kit.ns || scope?.startsWith(`${kit.ns}/`)) {
    return name.slice(kit.ns.length + 1);
  }
  return name;
}

/**
 * Register the derived standard tools on a toolkit. Idempotent by name, like
 * every other registration — safe to call from a module that re-evaluates
 * under HMR. Returns an unsubscribe for the control-surface watcher (rarely
 * needed; a page teardown drops everything anyway).
 */
export function registerStandardTools(
  kit: AgentToolkit,
  options?: StandardToolsOptions,
): () => void {
  const view = surfaceViewFor(kit.ns, options?.scopes);
  kit.registerTool({
    name: "report",
    description:
      "One bounded snapshot of the whole app, assembled from the reflection registries: " +
      "controls (the writable surface, with values), actions (invocable verbs), cells " +
      "(derived computations, with states), dependency edges (which controls/cells each " +
      "cell's deps read), and the app's custom sections. format: \"brief\" (default, compact " +
      'maps) or "full" (adds descriptions, definition sites file:line, and constraint ' +
      "metadata). Call this FIRST.",
    usage:
      "Call it before answering a question about the app's state or before the first " +
      "write, and again after a write when a count or a derived value matters.",
    kind: "read",
    params: { format: '"brief" (default) | "full"' },
    inputSchema: {
      type: "object",
      properties: { format: { type: "string", enum: ["brief", "full"] } },
      additionalProperties: false,
    },
    run: (args) => buildReport(kit, view, args?.format === "full" ? "full" : "brief"),
  });

  kit.registerTool({
    name: "set",
    description:
      "Set one control (the app's writable surface — discover names, current values, and " +
      "constraints via report). The write is validated by the control's own metadata: numbers " +
      "clamp to min/max and snap to step, enums must match an option, wrong types throw. " +
      "Returns the value actually written (never a re-read — writes are batched).",
    usage:
      "One control per call; trust the returned value over the request (it clamps and " +
      "snaps). Names, bounds, and units come from report.",
    kind: "write",
    params: { name: "control name (see report)", value: "the new value" },
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" }, value: {} },
      required: ["name", "value"],
      additionalProperties: false,
    },
    run: (args) => {
      const name = String(args?.name ?? "");
      const c = controlByName(name);
      // OWNED controls only — same view as report, so a kit cannot write a
      // sibling app's control in a multi-app document (and the error's
      // control list stays the kit's own, not the document's).
      if (!c || !view.owns(c.name)) {
        const known = controlSurface()
          .filter((e) => e.kind === "control" && view.owns(e.name))
          .map((e) => e.name)
          .join(", ");
        throw new Error(`no control "${name}" — controls: ${known || "(none declared)"}`);
      }
      const written = c.set(args?.value as never);
      return { name, value: written };
    },
  });

  kit.registerTool({
    name: "locate",
    description:
      "Map DOM elements to their source locations (compile-time data-source-loc stamps). " +
      "Combine with window.__AIUI__.sourceRoot for absolute paths.",
    kind: "read",
    params: { selector: `CSS selector; first ${LOCATE_LIMIT} matches returned` },
    run: (args) => {
      const selector = String(args?.selector ?? "*");
      return [...document.querySelectorAll(selector)].slice(0, LOCATE_LIMIT).map((el) => ({
        tag: el.tagName.toLowerCase(),
        text: (el.textContent ?? "").trim().slice(0, 40),
        source: el.closest("[data-source-loc]")?.getAttribute("data-source-loc") ?? null,
        cell: el.closest("[data-cell]")?.getAttribute("data-cell") ?? null,
      }));
    },
  });

  kit.registerTool({
    name: "read-page",
    description:
      "Read the page the user is looking at as text: headings, prose, lists, tables, the " +
      "numbers on screen, and every equation as its TeX source ($…$ inline, $$…$$ display). " +
      "Markdown-shaped. Returns { text, chars, truncated, headings }.",
    usage:
      "Call it to answer a question about what the page says or shows, or before referring " +
      "to something on screen. Start with the whole page (headings come back as an outline), " +
      "narrow with selector (a CSS selector, as locate uses) for one section, and page with " +
      "offset when truncated is true. The page's own agent chrome (the tool log, a voice " +
      "dock) is never included.",
    kind: "read",
    params: {
      selector: "CSS selector of the region to read (default: the whole page)",
      maxChars: `characters per call (default ${READ_PAGE_DEFAULT_CHARS}, max ${READ_PAGE_MAX_CHARS})`,
      offset: "characters to skip — paging through a long page",
    },
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string" },
        maxChars: { type: "number", minimum: 1, maximum: READ_PAGE_MAX_CHARS },
        offset: { type: "number", minimum: 0 },
      },
      additionalProperties: false,
    },
    run: (args) => {
      const selector = typeof args?.selector === "string" ? args.selector.trim() : "";
      const root = selector === "" ? document.body : document.querySelector(selector);
      if (root === null) throw new Error(`no element matches "${selector}"`);
      const maxChars = Math.min(
        READ_PAGE_MAX_CHARS,
        typeof args?.maxChars === "number" && args.maxChars > 0
          ? Math.floor(args.maxChars)
          : READ_PAGE_DEFAULT_CHARS,
      );
      const offset =
        typeof args?.offset === "number" && args.offset > 0 ? Math.floor(args.offset) : 0;
      return pageText({ root, maxChars, offset });
    },
  });

  kit.registerTool({
    name: "selection",
    description:
      "What the user has selected on the page: the text, its TeX when it is rendered " +
      "mathematics, and where it came from — the elements that authored it (nearest first, " +
      "with file:line:col), the cells that produced it (name, live state, definition site), " +
      "and the control it sits in. The document's selection right now, or the last one for " +
      "two minutes after focus moved (live says which). { selected: false } when there is none.",
    usage:
      'Call it when the user says "this", "here", "the selected…", or asks about something ' +
      "they highlighted. Every location's file is exactly what source takes, so follow up " +
      "with source { file, from: line - 20, to: line + 20 }. Pass source: false to drop the " +
      `locations, depth to bound both chains (default ${SELECTION_DEFAULT_DEPTH}), maxChars ` +
      `to widen the text (default ${SELECTION_DEFAULT_CHARS}), format: "markdown" to get a ` +
      "table or an equation shaped, rects: true for screen geometry.",
    kind: "read",
    params: {
      maxChars: `characters of text (default ${SELECTION_DEFAULT_CHARS}, max ${SELECTION_MAX_CHARS})`,
      depth: `how many elements and cells each chain lists (default ${SELECTION_DEFAULT_DEPTH}, max ${SELECTION_MAX_DEPTH})`,
      source: "include source locations (default true)",
      rects: "include the selection's screen rectangles (default false)",
      format: '"text" (default) | "markdown" (adds the fragment rendered as read-page does)',
    },
    inputSchema: {
      type: "object",
      properties: {
        maxChars: { type: "number", minimum: 1, maximum: SELECTION_MAX_CHARS },
        depth: { type: "number", minimum: 0, maximum: SELECTION_MAX_DEPTH },
        source: { type: "boolean" },
        rects: { type: "boolean" },
        format: { type: "string", enum: ["text", "markdown"] },
      },
      additionalProperties: false,
    },
    run: (args) => {
      const selection = pageSelection({
        ...(typeof args?.maxChars === "number" ? { maxChars: args.maxChars } : {}),
        ...(typeof args?.depth === "number" ? { depth: args.depth } : {}),
        ...(typeof args?.source === "boolean" ? { source: args.source } : {}),
        ...(typeof args?.rects === "boolean" ? { rects: args.rects } : {}),
        ...(args?.format === "markdown" ? { format: "markdown" as const } : {}),
      });
      if (selection === null) {
        return {
          selected: false,
          note: "nothing is selected on the page (a selection is kept for two minutes after focus moves on)",
        };
      }
      return { selected: true, ...selection };
    },
  });

  kit.registerTool({
    name: "sources",
    description:
      "List the source files this page can read — the paths source takes, as the stamps " +
      'name them (src/ui/App.tsx). Returns { mode, total, files }: mode "dev" (a dev server ' +
      'serving the workspace), "shipped" (a build that carries its code) or "none" (this ' +
      "page carries no source, and the note says so).",
    usage:
      "Call it before source when no stamp has named a file yet (selection, locate and " +
      "report full all do), or to see what a published build included. filter narrows by " +
      `substring (a directory, an extension); limit caps the list (default ${SOURCES_DEFAULT_LIMIT}).`,
    kind: "read",
    params: {
      filter: "keep paths containing this substring",
      limit: `at most this many paths (default ${SOURCES_DEFAULT_LIMIT})`,
    },
    inputSchema: {
      type: "object",
      properties: {
        filter: { type: "string" },
        limit: { type: "number", minimum: 1 },
      },
      additionalProperties: false,
    },
    run: async (args) => {
      const listing = await listSources();
      const filter = typeof args?.filter === "string" ? args.filter.trim().toLowerCase() : "";
      const limit =
        typeof args?.limit === "number" && args.limit > 0
          ? Math.floor(args.limit)
          : SOURCES_DEFAULT_LIMIT;
      const all = (listing.files ?? []).filter(
        (f) => filter === "" || f.toLowerCase().includes(filter),
      );
      return {
        mode: listing.mode,
        total: all.length,
        files: all.slice(0, limit),
        ...(all.length > limit ? { truncated: true } : {}),
        ...(listing.note !== undefined ? { note: listing.note } : {}),
      };
    },
  });

  kit.registerTool({
    name: "source",
    description:
      "Read one of the app's own source files, by the path the stamps use (selection, locate, " +
      'report { format: "full" } and data-source-loc say `src/ui/App.tsx:42` — the file is the ' +
      "part before the first colon), as numbered lines. Returns { file, from, to, total, more, " +
      "text }, or { file, available: false, reason, suggestions } when this page cannot read it.",
    usage:
      "Pass file exactly as a stamp names it. from/to pick a line range (default the first " +
      `${SOURCE_DEFAULT_LINES} lines; a call stops early at 32 KB and \`to\` says where; \`more\` ` +
      "means lines remain). Omit file to get the same listing sources gives. Reads on a dev " +
      'server, or on a site built with aiui({ sources: "ship" }); otherwise available is false ' +
      "and reason says why.",
    kind: "read",
    params: {
      file: "the file, as stamped (src/…)",
      from: "first line, 1-based",
      to: "last line, inclusive",
    },
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string" },
        from: { type: "number", minimum: 1 },
        to: { type: "number", minimum: 1 },
      },
      additionalProperties: false,
    },
    run: async (args) => {
      const file = typeof args?.file === "string" ? args.file.trim() : "";
      if (file === "") {
        const listing = await listSources();
        return {
          mode: listing.mode,
          total: listing.files?.length ?? 0,
          files: listing.files?.slice(0, SOURCES_DEFAULT_LIMIT) ?? [],
          ...(listing.note !== undefined ? { note: listing.note } : {}),
        };
      }
      try {
        return await readSource(file, {
          ...(typeof args?.from === "number" ? { from: args.from } : {}),
          ...(typeof args?.to === "number" ? { to: args.to } : {}),
        });
      } catch (err) {
        if (err instanceof SourceUnavailableError) {
          return {
            file,
            available: false,
            reason: err.reason,
            ...(err.suggestions.length > 0 ? { suggestions: err.suggestions } : {}),
          };
        }
        throw err;
      }
    },
  });

  // The attribution table: every live named cell OF THIS KIT'S VIEW, its
  // state, and where it is defined — names match the data-cell stamps in the
  // DOM. (Kept as a reporter so handle.report() aggregations and older
  // consumers keep working; the `report` tool above is the format-aware
  // superset.)
  kit.registerReporter("cells", () => cellRegistry().filter((c) => view.owns(c.name)));
  // The airlock table: named bridgeEffect crossings and their failure history
  // (a bridge failure is recorded, not thrown — this is where it surfaces).
  kit.registerReporter("bridges", () => bridgeRegistry().filter((b) => view.owns(b.name)));

  // ---- actions become real tools, whatever order they were declared in -----
  // OWNED actions only: the control surface is global, the kit's view is not.
  const syncActionTools = () => {
    for (const entry of controlSurface()) {
      if (entry.kind !== "action" || !view.owns(entry.name)) continue;
      const tool = toolOfAction(entry.name, kitRelativeName(kit, entry.name, entry.scope));
      if (tool) kit.registerTool(tool);
    }
  };
  syncActionTools();
  return subscribeControlSurface(syncActionTools);
}
