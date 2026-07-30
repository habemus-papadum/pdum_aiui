/**
 * claims.ts — the client's operations, derived (parity inventory §2B: every
 * hand-called `sync*` the retired extension panel carried, re-expressed as a
 * claim nobody calls — git history: aiui-extension's panel).
 *
 * Each claim is a pure derivation from (state, ctx) plus an async applier
 * over the host seam. The reconciler (aiui-viz/modal claims.ts) drives them
 * after every commit: a forgotten sync is structurally impossible, a tab
 * switch re-points everything that names a tab, and per-claim status is the
 * UI's "warming / live / failed" truth.
 */

import type { ClaimSpecs, EngineState } from "@habemus-papadum/aiui-viz/modal";
import { claimedPageKeys } from "./keys";
import { type IntentContext, sink } from "./spec";
import type { HeldStream, IntentHost, RingState } from "./transport";

/** Lane hooks: the REAL operations behind two claims (the fake host's
 * transport assertions remain the default, which is what harness tests
 * drive). */
export interface ClaimLaneOptions {
  /** Vanishing lifetime for the pencil assertion (0 = persist). */
  pencilFadeSec?: () => number;
  /** A tab's pencil surface got engaged — lanes track the set so disarm can
   * sweep-clear strokes on every tab that has any (client.ts runVerbs). */
  onPencilEngaged?: (tab: number) => void;
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
    /** The pencil markup surface — a PAGE act that follows the tab in view
     * (no grant — a stylus, a mouse, and the iPad's strokes all land in-page),
     * asserted while pencil MODE is on, armed or in a turn (C2, owner
     * 2026-07-25: markup is a source; the mode is the switch, not the turn).
     * acquire ENGAGES
     * (the surface owns the pointer); release DISENGAGES (strokes STAY —
     * page-side keeps the surface). The live fade re-relay is a separate
     * effect in lanes.ts. */
    pencilSurface: {
      derive: (s, ctx) =>
        (s.phase === "turn" || s.phase === "armed") &&
        s.pencil === true &&
        ctx.activeTab !== undefined
          ? { tab: ctx.activeTab }
          : null,
      acquire: async (desire: { tab: number }) => {
        await transport.requestPage(desire.tab, "pencil", {
          op: "engage",
          fadeSec: options.pencilFadeSec?.() ?? 0,
        });
        options.onPencilEngaged?.(desire.tab);
        return desire.tab;
      },
      release: async (tab: number) => {
        await transport.requestPage(tab, "pencil", { op: "disengage" });
      },
    },

    /** The area drag surface — the crosshair rubber-band raised while area mode
     * is on in an open turn (owner, 2026-07-16). PIXELS, so it follows the GRANT
     * (the tab in view must be the granted tab), unlike pencil. acquire arms
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
        (s.phase === "turn" || s.phase === "armed") &&
        s.jump === true &&
        ctx.aiuiPage &&
        ctx.activeTab !== undefined
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

    /** The warm capture stream — ARMED-scoped (C1, owner 2026-07-25: video is
     * a SOURCE, and sources are not turn-gated). Held from the moment the
     * client is armed with a grant in hand: the iPad mirror runs without a
     * turn, a turn end no longer freezes it, and an in-turn shot still rides
     * the same warmth. Only disarm releases it. What stays turn-scoped is the
     * ROUTE — videoSample below feeds the PROMPT, which only exists in a
     * turn. (CDP tier: holdStream is a no-op handle; its screencast has its
     * own viewer-driven lifecycle.) */
    tabStream: {
      derive: (s, ctx) =>
        s.phase !== "disarmed" && ctx.grantedTab !== undefined ? { tab: ctx.grantedTab } : null,
      acquire: (desire: { tab: number }) => capture.holdStream(desire.tab),
      release: (stream: HeldStream) => {
        stream.release();
      },
    },

    /** Frame sampling: sink ∧ video ∧ grant — smart or constant cadence.
     * Default applier asserts the page-side flag (the fake host / tests);
     * the real client passes `options.videoSampler`, whose start() runs the
     * VideoSampler pump (frames → engine shots → wire attachments). */
    videoSample: {
      // Gated like `shot` (spec.ts): pixels only while the tab in view IS the
      // granted tab — sampling a background tab would contradict the hollow
      // ring. Sampled frames feed the SINK, so a paused turn stops the pump
      // (the claim releases) and a resume restarts it — while the video MODE
      // stands lit throughout (pause never touches standing modes). The warm
      // stream below deliberately does NOT gate on this: it stays held on the
      // granted tab so returning to it costs nothing.
      derive: (s, ctx) =>
        sink(s) !== undefined &&
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

    /** Key capture pointed at the active tab — ARMED-level since C3′, with
     * the claimed-key SET riding the payload: "all" in a turn (the wholesale
     * claim, unchanged), exactly the armed grammar's live bound keys while
     * merely armed (everything else stays the page's; Escape never claimed
     * outside a turn). The desire embeds the set, so a state change that
     * moves the set (pencil on ⇒ `c` joins) re-asserts structurally. */
    keyRouting: {
      derive: (s, ctx) =>
        s.phase !== "disarmed" && ctx.activeTab !== undefined
          ? { tab: ctx.activeTab, keys: claimedPageKeys(s) }
          : null,
      acquire: async (desire: { tab: number; keys: "all" | string[] }) => {
        await transport.requestPage(desire.tab, "keylayer", {
          capture: true,
          keys: desire.keys,
        });
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
          turnTone: s.phase === "turn",
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
