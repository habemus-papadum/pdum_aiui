/**
 * bridge-effect.ts — the airlock between the reactive graph and imperative
 * systems.
 *
 * Solid 2.0 (beta.32) semantics: a SYNCHRONOUS throw in an effect's handler
 * escalates to the nearest error boundary — and with none, it permanently
 * halts the whole document's reactive system (recoverable only via Solid's
 * `resetErrorHalt`). Handlers that cross into foreign systems — engine
 * setters, worker `postMessage`, `chrome.*` calls, socket sends, canvas
 * contexts — are exactly where such throws originate ("extension context
 * invalidated", a DataCloneError, a lost GL context). And the durable graphs
 * those bridges usually live in (`hotCellGraph` roots) OUTLIVE any page
 * mount, so no page-level boundary can contain them: `PageBoundary` guards
 * the component tree; this guards the graph.
 *
 * `bridgeEffect` is `createEffect` with the crossing hardened. The tracked
 * compute is untouched (its errors keep normal boundary routing — a compute
 * bug should stay loud); the handler runs inside a catch, and a caught
 * failure is RECORDED — into the bridge registry (agent-visible through the
 * `report` tool, like cells) and onto the console — while the bridge stays
 * alive for the next change. A foreign system's failure is a fact to
 * surface, never a reason to stop delivering parameters.
 *
 * Async work needs no airlock: a rejected promise inside a handler is an
 * unhandled rejection, not an effect-phase throw — it cannot halt the graph.
 * (Still `.catch()` it, for the console's sake.)
 *
 * Like `cell()`, the aiui compiler injects `loc`/`description` (and an
 * inferred `name` where a binding provides one) at the declaration site;
 * bridges declared as bare statements should carry an explicit `name` so the
 * registry and the report can attribute their failures. `scope` qualifies the
 * name in a multi-app document, exactly as it does for cells.
 */
import { createEffect, onCleanup } from "solid-js";
import type { Scope } from "./scope";

export interface BridgeEffectOptions {
  /** Stable identity for the registry and the report (see cell()'s naming
   * contract). Bridges are usually bare statements, so write it explicitly. */
  name?: string;
  /** Instance qualifier for slice factories — the registered name becomes
   * `<scope>/<name>`. */
  scope?: Scope;
  /** Definition site "file:line"; injected by the aiui compiler. */
  loc?: string;
  /** Lifted from the leading doc comment by the aiui compiler. */
  description?: string;
  /** Optional extra hook, called after a failure is recorded. */
  onError?: (error: unknown) => void;
}

export interface BridgeEntry {
  name: string;
  loc: string | undefined;
  description: string | undefined;
  /** Total handler failures since the bridge was created. */
  errorCount: number;
  /** `String(error)` of the most recent failure, if any. */
  lastError: string | undefined;
  /** Epoch ms of the most recent failure, if any. */
  lastErrorAt: number | undefined;
}

// Named bridges register here, mirroring the cell registry: per-page module
// state, deregistered when the owner is disposed (a durable graph's bridges
// live as long as the graph — exactly right).
const registry = new Map<string, BridgeEntry>();

/** Snapshot of every live named bridge — the report's `bridges` section. */
export function bridgeRegistry(): BridgeEntry[] {
  return [...registry.values()].map((e) => ({ ...e }));
}

/** Look up a live bridge's entry by its qualified name. */
export function bridgeByName(name: string): BridgeEntry | undefined {
  const e = registry.get(name);
  return e ? { ...e } : undefined;
}

/**
 * `createEffect` for a handler that crosses into an imperative system: the
 * crossing is hardened (a sync throw is recorded, not escalated), the bridge
 * survives to deliver the next change. See the module doc for when this is
 * the right primitive — pure-reactive effects should stay `createEffect`,
 * where a throw is a bug you want loud.
 */
export function bridgeEffect<S>(
  compute: () => S,
  handler: (value: S, prev: S | undefined) => void,
  options?: BridgeEffectOptions,
): void {
  const name =
    options?.name !== undefined
      ? options.scope !== undefined
        ? options.scope.qualify(options.name)
        : options.name
      : undefined;

  let entry: BridgeEntry | undefined;
  if (name !== undefined) {
    entry = {
      name,
      loc: options?.loc,
      description: options?.description,
      errorCount: 0,
      lastError: undefined,
      lastErrorAt: undefined,
    };
    registry.set(name, entry);
    onCleanup(() => {
      if (registry.get(name) === entry) registry.delete(name);
    });
  }

  let prev: S | undefined;
  createEffect(compute, (value: S) => {
    try {
      handler(value, prev);
    } catch (error) {
      if (entry) {
        entry.errorCount++;
        entry.lastError = String(error);
        entry.lastErrorAt = Date.now();
      }
      console.error(`[bridge${name ? ` ${name}` : ""}] handler failed`, error);
      options?.onError?.(error);
    }
    // Advance even after a failure: the compute succeeded, so the next run's
    // `prev` is this value regardless of whether the crossing delivered it.
    prev = value;
  });
}
