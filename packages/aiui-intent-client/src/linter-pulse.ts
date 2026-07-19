/**
 * linter-pulse.ts — a client-side MIRROR of the linter sidecar's state
 * machine (channel linter-sidecar.ts), driven from the engine's event stream
 * plus the one client-side input the sidecar cannot echo: the `lint now`
 * button ({@link LinterPulse.lintNow}, called by the lanes verb that sends
 * the control chunk). No new wire traffic.
 *
 * Converse-only (overhear retired 2026-07-19): the linter ACCUMULATES
 * silently — talk segments open one long window; nothing ends it but the
 * button — so the mirrored lifecycle is:
 *
 *   off → idle → listening ──(lint now)→ thinking → noted → idle
 *                    ↑  └─ stays listening across talk-ends (accumulation)
 *                    └── barge-in (talk over the reply) ──┘
 *
 * `tool` overlays thinking while a linter tool call is in flight; `stale`
 * replaces thinking when no note lands inside {@link LINTER_STALE_MS} (and
 * fires `onStale` once — the warning toast); `linter-turn-complete` settles
 * everything back to idle (the linter STAYS ON — press again to lint again).
 * This is advisory UI over an advisory feature: drift costs a dot being
 * briefly wrong, never a behavior.
 */

import type { IntentEvent } from "@habemus-papadum/aiui-lowering-pipeline";
import { createSignal } from "solid-js";

/** No note this long after the lint turn ended → stale (owner: warn at 4s). */
export const LINTER_STALE_MS = 4000;
/** How long the 💡 "noted" flash lingers before settling back to idle. */
export const LINTER_NOTED_FLASH_MS = 2500;

export type LinterPulsePhase =
  | "off" // the linter select is off
  | "idle" // on, nothing accumulated or in flight
  | "listening" // a talk window opened — the linter is accumulating
  | "thinking" // the button fired — a note should be composing
  | "tool" // …and a linter tool call is in flight
  | "noted" // a note landed (brief flash)
  | "stale"; // no note within the deadline (warned once)

export interface LinterPulseView {
  phase: LinterPulsePhase;
  /** One tooltip-sized line saying what the phase means right now. */
  detail: string;
}

export interface LinterPulseOptions {
  /** Whether the linter is on (the select, read live). */
  enabled: () => boolean;
  /** Fired once per wait when no note lands inside {@link LINTER_STALE_MS}. */
  onStale?: () => void;
}

export interface LinterPulse {
  /** Feed every engine event (wire the existing engine.onEvent tap here). */
  feed(event: IntentEvent): void;
  /**
   * The `lint now` button fired (the lanes verb calls this beside sending the
   * control chunk): the accumulated window is being judged — start the note
   * wait. A press with nothing accumulated mirrors the sidecar's no-op.
   */
  lintNow(): void;
  /** The current phase, reactively (off whenever the select says off). */
  view(): LinterPulseView;
  dispose(): void;
}

export function createLinterPulse(options: LinterPulseOptions): LinterPulse {
  // Plain state + a rev signal as the reactive NOTIFIER: Solid 2.0 defers
  // signal writes to the flush, but feed() callers (and tests) must see the
  // new phase synchronously — the signal only tells the graph to re-read.
  let current: LinterPulseView = { phase: "idle", detail: "linter idle" };
  const [rev, setRev] = createSignal(0, { ownedWrite: true });

  let staleTimer: ReturnType<typeof setTimeout> | undefined;
  let notedTimer: ReturnType<typeof setTimeout> | undefined;
  /** The tool in flight while thinking, if any. */
  let toolInFlight: string | undefined;

  const clearTimers = (): void => {
    clearTimeout(staleTimer);
    clearTimeout(notedTimer);
    staleTimer = undefined;
    notedTimer = undefined;
  };

  const to = (phase: LinterPulsePhase, detail: string): void => {
    current = { phase, detail };
    setRev((n) => n + 1);
  };

  /** The button fired: a note is due — start the stale deadline. */
  const think = (): void => {
    to("thinking", "waiting for the linter's note (lint now)");
    clearTimeout(staleTimer);
    staleTimer = setTimeout(() => {
      to("stale", `no lint within ${LINTER_STALE_MS / 1000}s`);
      options.onStale?.();
    }, LINTER_STALE_MS);
  };

  const feed = (event: IntentEvent): void => {
    if (!options.enabled()) {
      return; // off: the view() derivation shows "off"; track nothing
    }
    switch (event.type) {
      case "talk-start": {
        // Accumulation (and the barge-in): whatever was in flight, the human
        // is talking again — the linter is listening. Talk-ENDS deliberately
        // change nothing: the window stays open until the button.
        clearTimers();
        toolInFlight = undefined;
        to("listening", "the linter is accumulating (lint now to judge it)");
        break;
      }
      case "linter-tool-call": {
        toolInFlight = event.tool;
        to("tool", `linter tool: ${event.tool}`);
        break;
      }
      case "linter-tool-result": {
        if (toolInFlight !== undefined) {
          toolInFlight = undefined;
          // Back to composing — the stale deadline kept running throughout.
          to("thinking", `linter tool ${event.tool} ${event.ok ? "done" : "failed"}`);
        }
        break;
      }
      case "linter-note": {
        clearTimers();
        toolInFlight = undefined;
        to("noted", event.text);
        notedTimer = setTimeout(() => {
          to("idle", "linter idle");
        }, LINTER_NOTED_FLASH_MS);
        break;
      }
      case "linter-turn-complete": {
        // The lint finished (stay-on): settle to idle so no timer outlives
        // the exchange — the next talk-start starts accumulating again.
        clearTimers();
        toolInFlight = undefined;
        to("idle", "lint turn complete");
        break;
      }
      case "thread-close": {
        // fin closes the linter session server-side — nothing more can come.
        clearTimers();
        toolInFlight = undefined;
        to("idle", "linter idle");
        break;
      }
      default:
        break;
    }
  };

  return {
    feed,
    lintNow: () => {
      // Mirrors the sidecar's guard: only an open (accumulating) window
      // lints; an idle press is the same no-op the channel makes it.
      if (options.enabled() && current.phase === "listening") {
        think();
      }
    },
    view: () => {
      void rev(); // subscribe: in-graph readers re-run per transition
      return options.enabled() ? current : { phase: "off", detail: "linter off (the select)" };
    },
    dispose: clearTimers,
  };
}
