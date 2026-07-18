/**
 * mirror.ts — turn persistence across page reloads (the retired panel's
 * storage.session mirror, plain-page grade). The default sessionStorage
 * mirror is instantiated by a LAZY call in the assembly, never at module load,
 * so importing this module on node (the sidecar entry shares the package)
 * never touches the sessionStorage global.
 */

import type { IntentEvent } from "@habemus-papadum/aiui-lowering-pipeline";

/** Turn persistence across page reloads (the retired panel's storage.session
 * mirror, plain-page grade). Default: sessionStorage under `aiui2.turn`. */
export interface TurnMirror {
  persist(events: IntentEvent[], threadOpen: boolean): void;
  recover(): { events: IntentEvent[]; threadOpen: boolean } | undefined;
}

const MIRROR_KEY = "aiui2.turn";

export function sessionStorageMirror(storage: Storage = sessionStorage): TurnMirror {
  return {
    persist(events, threadOpen) {
      if (threadOpen && events.length > 0) {
        storage.setItem(MIRROR_KEY, JSON.stringify({ events, threadOpen, savedAt: Date.now() }));
      } else {
        storage.removeItem(MIRROR_KEY);
      }
    },
    recover() {
      try {
        const raw = storage.getItem(MIRROR_KEY);
        if (raw === null) {
          return undefined;
        }
        const got = JSON.parse(raw) as { events?: IntentEvent[]; threadOpen?: boolean };
        return Array.isArray(got.events) && got.events.length > 0
          ? { events: got.events, threadOpen: got.threadOpen === true }
          : undefined;
      } catch {
        return undefined;
      }
    },
  };
}
