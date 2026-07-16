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
  /** Vanishing lifetime for the pencil assertion (0 = persist). Mirrors ink. */
  pencilFadeSec?: () => number;
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
    /** Ink pointer routed at the tab IN VIEW while inking in an open turn.
     * Ink is a page act (the surface lives in the content script/bootstrap),
     * so it follows `activeTab` like keys and selection do — the grant gates
     * only pixels (owner, 2026-07-14: the tab-switch gate split). */
    inkPointer: {
      derive: (s, ctx) =>
        s.phase === "turn" && s.ink === true && ctx.activeTab !== undefined
          ? { tab: ctx.activeTab }
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

    /** The pencil markup surface — the exact twin of inkPointer (owner,
     * 2026-07-16): a PAGE act that follows the tab in view (no grant — a stylus,
     * a mouse, and the iPad's strokes all land in-page), asserted while pencil
     * mode is on in an open turn. acquire ENGAGES (the surface owns the pointer);
     * release DISENGAGES (strokes STAY — page-side keeps the surface). The live
     * fade re-relay is a separate effect in lanes.ts, like ink's. */
    pencilSurface: {
      derive: (s, ctx) =>
        s.phase === "turn" && s.pencil === true && ctx.activeTab !== undefined
          ? { tab: ctx.activeTab }
          : null,
      acquire: async (desire: { tab: number }) => {
        await transport.requestPage(desire.tab, "pencil", {
          op: "engage",
          fadeSec: options.pencilFadeSec?.() ?? 0,
        });
        return desire.tab;
      },
      release: async (tab: number) => {
        await transport.requestPage(tab, "pencil", { op: "disengage" });
      },
    },

    /** The area drag surface — the crosshair rubber-band raised while area mode
     * is on in an open turn (owner, 2026-07-16). PIXELS, so it follows the GRANT
     * (the tab in view must be the granted tab), unlike ink/pencil. acquire arms
     * the page overlay; release lowers it. The mode auto-exits after a drag
     * (client.ts dispatches `regionDone` on the page's `regionDrag`), so this
     * claim's steady state is "armed until the user drags or steps out". */
    regionSurface: {
      derive: (s, ctx) =>
        s.phase === "turn" &&
        s.region === true &&
        ctx.grantedTab !== undefined &&
        ctx.grantedTab === ctx.activeTab
          ? { tab: ctx.activeTab }
          : null,
      acquire: async (desire: { tab: number }) => {
        await transport.requestPage(desire.tab, "region", { arm: true });
        return desire.tab;
      },
      release: async (tab: number) => {
        await transport.requestPage(tab, "region", { arm: false });
      },
    },

    /** The jump-to-editor picker — raised while jump mode is on in an open turn
     * on an INSTRUMENTED page (owner, 2026-07-16). A page act (follows the tab in
     * view, no grant — the picker reads the page's own stamps). acquire arms the
     * picker; release lowers it. Auto-exits on a commit/cancel: the page reports
     * `jumpDone` and client.ts dispatches the force-off. */
    jumpSurface: {
      derive: (s, ctx) =>
        s.phase === "turn" && s.jump === true && ctx.aiuiPage && ctx.activeTab !== undefined
          ? { tab: ctx.activeTab }
          : null,
      acquire: async (desire: { tab: number }) => {
        await transport.requestPage(desire.tab, "jump", { arm: true });
        return desire.tab;
      },
      release: async (tab: number) => {
        await transport.requestPage(tab, "jump", { arm: false });
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
      // Gated like `shot` (spec.ts): pixels only while the tab in view IS the
      // granted tab — sampling a background tab would contradict the hollow
      // ring. The warm stream below deliberately does NOT gate on this: it
      // stays held on the granted tab so returning to it costs nothing.
      derive: (s, ctx) =>
        s.phase === "turn" &&
        s.video === true &&
        ctx.grantedTab !== undefined &&
        ctx.grantedTab === ctx.activeTab
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
     * committed with the dispatch, so it CANNOT lag.
     *
     * On a GATED host (MV3) the desire also names the granted tab and the
     * activation hint: the buses project it per tab (ringForTab), and tabs
     * without the grant render HOLLOW with the hint — the fourth ring state,
     * which is how the page itself says "press ⌘B here" after a tab switch. */
    ring: {
      derive: (s, ctx): RingState => {
        const on = s.phase !== "disarmed";
        const gated = capture.grantless !== true;
        return {
          on,
          turnTone: inTurn(s),
          ...(on && gated
            ? {
                grant: {
                  ...(ctx.grantedTab !== undefined ? { tab: ctx.grantedTab } : {}),
                  hint: capture.grantHint ?? "activate",
                },
              }
            : {}),
        };
      },
      acquire: (desire: RingState) => {
        transport.broadcastRing(desire);
        return Promise.resolve(desire);
      },
      // No release: the next assertion replaces the last (broadcast is
      // idempotent); a dead panel's stale ring is the boot broadcast's job.
    },
  };
}
