/**
 * graph-trace.ts — runtime dependency edges, with zero Solid internals.
 *
 * The reflection registry wants to answer "which controls drive which cells,
 * and which cells feed which" without an agent reading source. The
 * cell-attribution spike proved the price of deriving such facts from Solid's
 * private reactive graph (pinned internals, prototype patches — retired; see
 * docs/proposals/solid-cell-attribution.md). This module is the cheap, exact
 * alternative that falls out of owning both primitives:
 *
 *   - `cell()` evaluates its deps function at exactly two known call sites; it
 *     brackets them with {@link runAsConsumer}, publishing "who is asking".
 *   - `control().get()` and a cell's reactive read call {@link recordRead};
 *     when a consumer is current, the (consumer, dependency) edge is recorded.
 *
 * Edges refresh per run: a deps evaluation RESETS its consumer's edge set, so
 * a cell that stops reading a control drops the edge on its next recompute.
 * Reads inside `compute` are deliberately not attributed — they are untracked
 * by Solid too, and attributing them would bless the out-of-sync bug the
 * testing harness exists to catch. Anonymous cells (no compiler, no explicit
 * name) record nothing: an edge needs two names.
 *
 * The consumer marker is a plain module global, not async-context: deps
 * functions are SYNCHRONOUS by contract (they run inside a Solid memo), so a
 * simple save/restore bracket is exact. Kept dependency-free and internal —
 * the public views are `dependencyEdges()` here and the `graph` section of
 * the standard tools' report.
 */

/** One dependency read: what kind of node, and its registered name. */
export interface DependencyRead {
  kind: "control" | "cell";
  name: string;
}

/** One consumer's latest-run reads. */
export interface DependencyEdge {
  /** The consuming cell's name. */
  cell: string;
  /** Everything its deps read on the most recent evaluation, in read order. */
  reads: DependencyRead[];
}

let currentConsumer: string | undefined;

/** consumer name → latest run's reads (insertion-ordered, deduped). */
const edges = new Map<string, Map<string, DependencyRead>>();

/**
 * Evaluate `fn` (a cell's deps function) attributed to `consumer`, resetting
 * that consumer's edge set first. `undefined` suspends attribution — used by
 * cell-internal re-reads (state derivation's gate check) so an outer cell
 * reading `inner.state()` inside its own deps is never blamed for the inner
 * cell's dependencies.
 */
export function runAsConsumer<T>(consumer: string | undefined, fn: () => T): T {
  const previous = currentConsumer;
  currentConsumer = consumer;
  if (consumer !== undefined) {
    edges.set(consumer, new Map());
  }
  try {
    return fn();
  } finally {
    currentConsumer = previous;
  }
}

/** Record a read of `dependency` against the current consumer, if any. */
export function recordRead(dependency: DependencyRead): void {
  if (currentConsumer === undefined || currentConsumer === dependency.name) {
    return;
  }
  edges.get(currentConsumer)?.set(`${dependency.kind}:${dependency.name}`, dependency);
}

/** Drop a consumer's edges (its cell deregistered — owner disposed). */
export function dropConsumer(consumer: string): void {
  edges.delete(consumer);
}

/**
 * Snapshot of the dependency graph as of each cell's latest deps run.
 * Consumers with no recorded reads (deps that touch only plain signals) are
 * included with an empty list — "this cell reads nothing registered" is
 * information too.
 */
export function dependencyEdges(): DependencyEdge[] {
  return [...edges.entries()].map(([cell, reads]) => ({
    cell,
    reads: [...reads.values()],
  }));
}

/** @internal Test hook: forget everything (module state outlives test files). */
export function resetDependencyEdges(): void {
  edges.clear();
  currentConsumer = undefined;
}
