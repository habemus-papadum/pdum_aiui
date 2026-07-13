/**
 * claims.ts — the client's operations, derived (parity inventory §2B, every
 * hand-called `sync*` of the old panel re-expressed as a claim nobody calls).
 *
 * Each claim is a pure derivation from (state, ctx) plus an async applier
 * over the host seam. The reconciler (aiui-viz/modal claims.ts) drives them
 * after every commit: a forgotten sync is structurally impossible, a tab
 * switch re-points everything that names a tab, and per-claim status is the
 * UI's "warming / live / failed" truth.
 *
 * The old panel's five sync functions map:
 *   syncInkPointer → inkPointer       syncTabStream → tabStream
 *   syncVideo      → videoSample      key routing   → keyRouting
 *   broadcastRing  → ring
 */

import type { ClaimSpecs, EngineState } from "@habemus-papadum/aiui-viz/modal";
import type { IntentContext } from "./spec";
import type { HeldStream, IntentHost, RingState } from "./transport";

const inTurn = (s: EngineState): boolean => s.phase === "turn" || s.phase === "tweak";

/** Lane hooks: the REAL operations behind two claims (the fake host's
 * transport assertions remain the default, which is what harness tests
 * drive). */
export interface ClaimLaneOptions {
  /** Vanishing-ink lifetime for the ink assertion (0 = page-permanent). */
  inkFadeSec?: () => number;
  /** The real frame pump: start sampling for a desire, return the stop. */
  videoSampler?: {
    start: (desire: { tab: number; mode: string }) => Promise<() => void>;
  };
}

export function intentClaims(
  host: IntentHost,
  options: ClaimLaneOptions = {},
): ClaimSpecs<EngineState, IntentContext> {
  const { transport, capture } = host;
  return {
    /** Ink pointer routed at the granted tab while inking in an open turn. */
    inkPointer: {
      derive: (s, ctx) =>
        s.phase === "turn" && s.ink === true && ctx.grantedTab !== undefined
          ? { tab: ctx.grantedTab }
          : null,
      acquire: async (desire: { tab: number }) => {
        await transport.requestPage(desire.tab, "ink", {
          on: true,
          fadeSec: options.inkFadeSec?.() ?? 0,
        });
        return desire.tab;
      },
      release: async (tab: number) => {
        await transport.requestPage(tab, "ink", { on: false });
      },
    },

    /** The warm capture stream, held for the turn's life (shots ride it). */
    tabStream: {
      derive: (s, ctx) =>
        inTurn(s) && ctx.grantedTab !== undefined ? { tab: ctx.grantedTab } : null,
      acquire: (desire: { tab: number }) => capture.holdStream(desire.tab),
      release: (stream: HeldStream) => {
        stream.release();
      },
    },

    /** Frame sampling: turn ∧ video ∧ grant — smart or constant cadence.
     * Default applier asserts the page-side flag (the fake host / tests);
     * the real client passes `options.videoSampler`, whose start() runs the
     * VideoSampler pump (frames → engine shots → wire attachments). */
    videoSample: {
      derive: (s, ctx) =>
        s.phase === "turn" && s.video === true && ctx.grantedTab !== undefined
          ? { tab: ctx.grantedTab, mode: s.videoMode as string }
          : null,
      acquire: async (desire: { tab: number; mode: string }) => {
        if (options.videoSampler !== undefined) {
          return { stop: await options.videoSampler.start(desire) };
        }
        await transport.requestPage(desire.tab, "viewport", {
          sample: true,
          mode: desire.mode,
        });
        return { desire };
      },
      release: async (actual: { stop?: () => void; desire?: { tab: number } }) => {
        if (actual.stop !== undefined) {
          actual.stop();
          return;
        }
        if (actual.desire !== undefined) {
          await transport.requestPage(actual.desire.tab, "viewport", { sample: false });
        }
      },
    },

    /** Key capture pointed at the active tab — in turn, NOT in tweak (the
     * page owns every ordinary key in tweak; only ⌘B resumes). */
    keyRouting: {
      derive: (s, ctx) =>
        s.phase === "turn" && ctx.activeTab !== undefined ? { tab: ctx.activeTab } : null,
      acquire: async (desire: { tab: number }) => {
        await transport.requestPage(desire.tab, "keylayer", { capture: true });
        return desire.tab;
      },
      release: async (tab: number) => {
        await transport.requestPage(tab, "keylayer", { capture: false });
      },
    },

    /** The on-page indicator — always asserted, tone from the phase. It was
     * the F1 poster child ("ring one state behind"): now it is a derivation
     * committed with the dispatch, so it CANNOT lag. */
    ring: {
      derive: (s): RingState => ({
        on: s.phase !== "disarmed",
        turnTone: inTurn(s),
      }),
      acquire: (desire: RingState) => {
        transport.broadcastRing(desire);
        return Promise.resolve(desire);
      },
      // No release: the next assertion replaces the last (broadcast is
      // idempotent); a dead panel's stale ring is the boot broadcast's job.
    },
  };
}
