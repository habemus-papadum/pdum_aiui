/**
 * linter-pulse.ts — a client-side MIRROR of the linter sidecar's state
 * machine (channel linter-sidecar.ts), driven purely from the engine's event
 * stream, so the panel can show where a lint is in its lifecycle without any
 * new wire traffic. Every input the sidecar keys on has a client-visible
 * counterpart:
 *
 *   sidecar                       here
 *   ───────────────────────────   ──────────────────────────────────────────
 *   onTalkStart / onTalkEnd       talk-start / talk-end engine events
 *   onTranscriptFinal             transcript-final (the server echo — the
 *                                 SAME signal the sidecar waits for)
 *   the 2.5s transcript wait      the same constant, mirrored below
 *   note / tool call / result     linter-note / linter-tool-call / -result
 *
 * The phases, in the order a normal lint passes through them:
 *
 *   off → idle → listening → transcript-wait → thinking → noted → idle
 *                     ↑ merge (talk resumes) ──┘      │
 *                     └── barge-in (talk over the reply) ──┘
 *
 * `tool` overlays thinking while a linter tool call is in flight; `stale`
 * replaces thinking when no note lands inside {@link LINTER_STALE_MS} (and
 * fires `onStale` once — the warning toast). This is advisory UI over an
 * advisory feature: clock skew against the channel is fine, drift costs a
 * dot being briefly wrong, never a behavior.
 */

import type { IntentEvent } from "@habemus-papadum/aiui-dev-overlay/intent-pipeline";
import { createSignal } from "solid-js";

/** Mirrors the sidecar's TRANSCRIPT_WAIT_MS (linter-sidecar.ts) — keep aligned. */
export const LINTER_TRANSCRIPT_WAIT_MS = 2500;
/** No note this long after the lint turn ended → stale (owner: warn at 4s). */
export const LINTER_STALE_MS = 4000;
/** How long the 💡 "noted" flash lingers before settling back to idle. */
export const LINTER_NOTED_FLASH_MS = 2500;

export type LinterPulsePhase =
  | "off" // the linter select is off
  | "idle" // on, nothing in flight
  | "listening" // a talk window is open — the linter hears the mic
  | "transcript-wait" // talk ended; the sidecar waits for the STT final (≤2.5s)
  | "thinking" // the lint turn ended — a note should be composing
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

  let transcriptTimer: ReturnType<typeof setTimeout> | undefined;
  let staleTimer: ReturnType<typeof setTimeout> | undefined;
  let notedTimer: ReturnType<typeof setTimeout> | undefined;
  /** The segment whose transcript the (mirrored) wait is armed for. */
  let armedSegment: number | undefined;
  /** The tool in flight while thinking, if any. */
  let toolInFlight: string | undefined;

  const clearTimers = (): void => {
    clearTimeout(transcriptTimer);
    clearTimeout(staleTimer);
    clearTimeout(notedTimer);
    transcriptTimer = undefined;
    staleTimer = undefined;
    notedTimer = undefined;
  };

  const to = (phase: LinterPulsePhase, detail: string): void => {
    current = { phase, detail };
    setRev((n) => n + 1);
  };

  /** The lint turn ended (transcript in, or the wait timed out): a note is
   * due — start the stale deadline. */
  const think = (why: string): void => {
    armedSegment = undefined;
    clearTimeout(transcriptTimer);
    transcriptTimer = undefined;
    to("thinking", `waiting for the linter's note (${why})`);
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
        // Mirrors the sidecar exactly: a resume during the transcript wait
        // MERGES (no turn boundary), and talking over a composing reply is
        // the barge-in — either way, the linter is listening again.
        clearTimers();
        armedSegment = undefined;
        toolInFlight = undefined;
        to("listening", "the linter hears the mic");
        break;
      }
      case "talk-end": {
        armedSegment = event.segment;
        to(
          "transcript-wait",
          `waiting for seg_${event.segment}'s transcript (≤${LINTER_TRANSCRIPT_WAIT_MS / 1000}s)`,
        );
        clearTimeout(transcriptTimer);
        transcriptTimer = setTimeout(() => {
          if (armedSegment === event.segment) {
            think("transcript timed out");
          }
        }, LINTER_TRANSCRIPT_WAIT_MS);
        break;
      }
      case "transcript-final": {
        if (armedSegment !== undefined && event.segment === armedSegment) {
          think("transcript in");
        }
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
        armedSegment = undefined;
        toolInFlight = undefined;
        to("noted", event.text);
        notedTimer = setTimeout(() => {
          to("idle", "linter idle");
        }, LINTER_NOTED_FLASH_MS);
        break;
      }
      case "thread-close": {
        // fin closes the linter session server-side — nothing more can come.
        clearTimers();
        armedSegment = undefined;
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
    view: () => {
      void rev(); // subscribe: in-graph readers re-run per transition
      return options.enabled() ? current : { phase: "off", detail: "linter off (the select)" };
    },
    dispose: clearTimers,
  };
}
