/**
 * Panel turn support: the effective config, the thread-events slice, and the
 * chrome.storage.session turn mirror. The WIRE itself is the overlay's shared
 * shell now (`aiui-dev-overlay/wire` + `/intent-thread`, adopted in Phase C1
 * — see docs/PHASE-C-PLAN.md); the hand-rolled twin that lived here is gone.
 */

import {
  DEFAULT_INTENT_CONFIG,
  expandTier,
  type IntentEvent,
  type IntentPipelineConfig,
} from "@habemus-papadum/aiui-dev-overlay/intent-pipeline";

/**
 * The panel's effective config, declared on every hello as `meta.intent` so
 * traces record reality. `transcriber: "mock"` is deliberate (seam analysis
 * gotcha #1): the shipped default would open a per-thread upstream vendor
 * socket at thread-open — pointless for a text-only host.
 */
export function panelIntentConfig(): IntentPipelineConfig {
  return { ...DEFAULT_INTENT_CONFIG, ...expandTier("mock"), tier: "mock" };
}

/** The events since the last thread-open — the persistence/replay unit. */
export function currentThreadEvents(events: readonly IntentEvent[]): IntentEvent[] {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === "thread-open") {
      return events.slice(i);
    }
  }
  return [];
}

/** chrome.storage.session mirror (per window) — the turn-store, panel-grade. */
export function turnMirror(windowId: () => number | undefined): {
  persist: (events: IntentEvent[], threadOpen: boolean) => void;
  recover: () => Promise<{ events: IntentEvent[]; threadOpen: boolean } | undefined>;
} {
  const key = (): string => `aiui.turn.win${windowId() ?? 0}`;
  return {
    persist(events, threadOpen) {
      if (threadOpen && events.length > 0) {
        void chrome.storage.session.set({ [key()]: { events, threadOpen, savedAt: Date.now() } });
      } else {
        void chrome.storage.session.remove(key());
      }
    },
    async recover() {
      const got = (await chrome.storage.session.get(key()))[key()] as
        | { events: IntentEvent[]; threadOpen: boolean }
        | undefined;
      return got !== undefined && Array.isArray(got.events) && got.events.length > 0
        ? { events: got.events, threadOpen: got.threadOpen }
        : undefined;
    },
  };
}
