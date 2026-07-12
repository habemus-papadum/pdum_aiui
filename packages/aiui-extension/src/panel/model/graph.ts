/**
 * graph.ts — the panel's disposable cell graph (frontend-design layer 2):
 * every async value the panel renders, as cells — supersession, error chrome,
 * and hot-swap rebuilds come from the machinery instead of hand-rolled
 * signal-and-forget promises (which is what this replaced: a one-shot swPing
 * signal and an imperative discover() writing three signals).
 *
 * The session BINDING (the bus client) stays an imperative island in
 * session-pane.tsx — a live stateful connection is not a cell; only the
 * DISCOVERY (a pure async question: "what channels exist right now?") is one.
 *
 * `panelCells` is exported as a factory for the headless tests
 * (graph.test.ts builds it inside `cellHarness`, per the methodology).
 */
import { action, cell, hotCellGraph } from "@habemus-papadum/aiui-viz";
import { relayRequest } from "@habemus-papadum/aiui-webext";
import {
  type ChannelEntry,
  discoverChannels,
  loadRecentPorts,
  nativeListChannels,
} from "../channel";
import { rescanTick } from "./store";

/** What the discovery cell yields: the channels and which tier found them. */
export interface Discovery {
  /** "native" = the zero-config native-host registry; "scan" = port probing. */
  source: "native" | "scan";
  list: ChannelEntry[];
}

/**
 * One discovery pass — the cell's compute AND the boot auto-bind's one-shot
 * question share this so the two paths cannot drift.
 */
export async function discoverOnce(): Promise<Discovery> {
  const native = await nativeListChannels();
  if (native !== undefined) {
    return { source: "native", list: native };
  }
  return { source: "scan", list: await discoverChannels(await loadRecentPorts()) };
}

export function panelCells() {
  return {
    /**
     * Channels visible to this browser — native host first (registry on
     * disk, zero config), port probing (recents) as the fallback. Re-runs
     * when the `rescan` action bumps the tick.
     */
    channels: cell(() => ({ tick: rescanTick.get() }), discoverOnce),
    /** Service-worker liveness (the Dev pane's probe); re-probed on rescan. */
    swPing: cell(
      () => ({ tick: rescanTick.get() }),
      () => relayRequest<{ at: string }>("sw", "ping"),
    ),
  };
}

export type PanelCells = ReturnType<typeof panelCells>;

/** The current graph — a stable accessor that survives hot swaps. */
export const graph = hotCellGraph(
  "panel",
  panelCells,
  // Passed, not read in the library: `import.meta.hot` is bound to THIS
  // module (see hotCellGraph's docs).
  import.meta.hot,
);

/** Re-scan for running aiui channels (and re-probe the service worker). */
export const rescan = action({
  run: () => {
    rescanTick.set(rescanTick.get() + 1);
  },
});
