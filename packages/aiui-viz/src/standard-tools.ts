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
import type { Scope } from "./scope";

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
