/**
 * graph.ts — the aztec cell graph (playbook layer 2): the shuffle run, the permanent check, the
 * derived observables, and the reactive→imperative render bridge, all built
 * over the durable roots in store.ts and published through a durable box the UI
 * subscribes to. Disposable logic: a hot edit disposes the old graph and builds
 * a new one over the same roots — the grown tiling (the frame ring), the
 * playhead, and the user's controls all survive.
 *
 * The agent tools are registered here, beside the capabilities they expose
 * (PRINCIPLES §5); the surface installs at window.__aztec.
 */

import {
  action,
  agentToolkit,
  type Cell,
  cell,
  hotCellGraph,
  registerStandardTools,
  workerStream,
} from "@habemus-papadum/aiui-viz";
import { type Accessor, createEffect, createMemo } from "solid-js";
import { tilingCount } from "./permanent";
import { draw } from "./render";
import {
  aztecScope,
  ctx2d,
  fps,
  frameIndex,
  frames,
  MAX_FRAMES,
  playing,
  regrow,
  runId,
  seed,
  showCircle,
  shuffleWorker,
  targetN,
} from "./store";
import type { PermanentCheck, PermanentResult, ShuffleFrame, ShuffleRequest } from "./types";

export interface FrozenPoint {
  n: number;
  frozenFraction: number;
}

export interface AztecGraph {
  /** The growth run: streams a frame per step; progress + cancel for free. */
  shuffle: Cell<ShuffleFrame>;
  /** Ryser permanents vs the EKLP formula, n = 1..4. */
  permanents: Cell<PermanentResult>;
  /** The frame currently under the playhead. */
  currentFrame: Accessor<ShuffleFrame | undefined>;
  /** Frozen-fraction vs order, across the recorded ring. */
  frozenSeries: Accessor<FrozenPoint[]>;
  permanentCheck: Accessor<PermanentCheck[] | undefined>;
}

function emitEveryFor(target: number): number {
  return Math.max(1, Math.ceil(target / (MAX_FRAMES - 8)));
}

// --- the graph: rebuilt over the durable roots on every hot edit --------------

/** The current graph — a stable accessor that survives hot swaps. */
export const aztecGraph = hotCellGraph<AztecGraph>(
  "aztec",
  () => {
    // ---- the shuffle run: worker stream, recorded into the ring ------------
    const shuffle = cell(
      () => ({ targetN: targetN.get(), seed: seed.get(), runId: runId.get() }),
      async function* (d, ctx): AsyncGenerator<ShuffleFrame, void, void> {
        const req: ShuffleRequest = {
          kind: "shuffle",
          targetN: d.targetN,
          seed: d.seed,
          emitEvery: emitEveryFor(d.targetN),
        };
        // Recording happens post-await (inside the loop), so these signal
        // writes are outside the memo's synchronous owned scope.
        for await (const frame of workerStream<ShuffleRequest, ShuffleFrame>(
          shuffleWorker,
          req,
          ctx,
        )) {
          frames.push(frame);
          yield frame;
        }
      },
      { scope: aztecScope },
    );

    // ---- the permanent check: runs once on load ----------------------------
    const permanents = cell(
      () => ({ maxN: 4 }),
      (d, ctx): AsyncGenerator<PermanentResult, void, void> =>
        workerStream<ShuffleRequest, PermanentResult>(
          shuffleWorker,
          { kind: "permanents", maxN: d.maxN },
          ctx,
        ),
      { scope: aztecScope },
    );

    // ---- a new run starts: reset the ring and playhead ---------------------
    // Keyed on run identity; runs synchronously, well before the first async
    // frame arrives, so it never clears freshly-streamed frames.
    createEffect(
      () => ({ t: targetN.get(), s: seed.get(), r: runId.get() }),
      () => {
        frames.clear();
        frameIndex.set(0);
        playing.set(true);
      },
    );

    // ---- render bridge: playhead / toggle / ring → the canvas island -------
    // The handler of createEffect(source, handler) is NOT a tracking scope in
    // Solid 2.0 (only the source is), so it consumes the source's value rather
    // than re-reading the signals — reading them here would warn
    // STRICT_READ_UNTRACKED and, in principle, miss updates.
    createEffect(
      () => ({ i: frameIndex.get(), circle: showCircle.get(), v: frames.version() }),
      (s) => draw(ctx2d, frames.at(s.i), { showCircle: s.circle }),
    );

    const currentFrame = () => {
      frames.version();
      return frames.at(frameIndex.get());
    };

    const frozenSeries = createMemo<FrozenPoint[]>(() => {
      frames.version();
      return frames.frames.map((f) => ({ n: f.n, frozenFraction: f.frozenFraction }));
    });

    return {
      shuffle,
      permanents,
      currentFrame,
      frozenSeries,
      permanentCheck: () => permanents.latest()?.permanents,
    } satisfies AztecGraph;
  },
  // Passed, not read here: `import.meta.hot` is bound to THIS module, and a
  // library can't self-accept on our behalf. See hotCellGraph's docs.
  import.meta.hot,
);

// --- agent tools --------------------------------------------------------------

function atEnd(): boolean {
  return frameIndex.get() >= frames.frames.length - 1;
}

function registerTools(): void {
  const kit = agentToolkit("aztec");
  const { registerReporter } = kit;
  // The derived surface: report/set/locate + one real tool per action(). The
  // old set-size/set-speed/toggle-circle tools dissolved into the controls in
  // store.ts — declaring IS exposing.
  registerStandardTools(kit);

  const current = () => aztecGraph().currentFrame();
  registerReporter("n", () => current()?.n ?? null);
  registerReporter("running", () => aztecGraph().shuffle.loading());
  registerReporter("frames", () => frames.frames.length);
  registerReporter("frozenFraction", () => current()?.frozenFraction ?? null);
  registerReporter("permanentCheck", () => aztecGraph().permanentCheck() ?? null);
  registerReporter("detail", () => {
    const f = current();
    return {
      targetN: targetN.get(),
      seed: seed.get(),
      size: f?.size ?? null,
      dominoes: f?.dominoes ?? null,
      tilingsFormula: f ? tilingCount(f.n) : null,
      frameIndex: frameIndex.get(),
      atEnd: atEnd(),
      playing: playing.get(),
      fps: fps.get(),
      showCircle: showCircle.get(),
      progress: aztecGraph().shuffle.progress() ?? null,
    };
  });
}

// --- actions: the verbs of the surface (each becomes a real agent tool) -------

/** Draw a fresh uniformly-random tiling (new seed) and replay the fold. */
action({
  scope: aztecScope,
  name: "regrow",
  params: { seed: "optional integer seed; omit for random" },
  run: (args) => {
    let s: number;
    if (typeof args?.seed === "number") {
      s = args.seed >>> 0;
      seed.set(s);
    } else {
      s = regrow();
    }
    return { seed: s, targetN: targetN.get() };
  },
});

/** Resume the growth animation (restarts from AD(1) if at the end). */
action({
  scope: aztecScope,
  name: "play",
  run: () => {
    if (atEnd()) frameIndex.set(0);
    playing.set(true);
    return { playing: true };
  },
});

/** Pause the growth animation on the current frame. */
action({
  scope: aztecScope,
  name: "pause",
  run: () => {
    playing.set(false);
    return { playing: false };
  },
});

/** Move the playhead to a frame by ring index or by order n. */
action({
  scope: aztecScope,
  name: "seek",
  params: { index: "ring index", n: "target order to jump to" },
  run: (args) => {
    const rows = frames.frames;
    let i = frameIndex.get();
    if (typeof args?.index === "number") i = Math.round(args.index);
    else if (typeof args?.n === "number") {
      const found = rows.findIndex((f) => f.n >= (args.n as number));
      if (found >= 0) i = found;
    }
    const target = Math.max(0, Math.min(rows.length - 1, i));
    frameIndex.set(target);
    playing.set(false);
    // Return the computed target, not a re-read: Solid 2.0 batches the write
    // transactionally, so a same-tick frameIndex.get() can still show the old
    // value.
    return { index: target, n: rows[target]?.n };
  },
});

registerTools(); // idempotent by name
