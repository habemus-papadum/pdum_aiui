/**
 * Turn recovery: keep an in-progress intent turn alive across the two ways the
 * multimodal modality can be torn down and rebuilt underneath a running turn.
 *
 * ## The HMR finding (design-choices grade)
 *
 * The overlay is pulled into a consumer's dev server **source-first** (the demo
 * is a `workspace:^` consumer), so editing an overlay source file goes through
 * Vite's HMR machinery. But the overlay has **no `import.meta.hot.accept`
 * anywhere** in its import graph — the entry is the Vite plugin's virtual mount
 * module, which imports the package barrel, which fans out to `intent.ts` →
 * `multimodal/*` → the pipeline. `import.meta.hot.accept(dep)` only works in a
 * *direct* importer of the changed module, so with no acceptor on any hop, a
 * change to (say) `multimodal/modality.ts` bubbles past every module to the
 * entry and Vite **full-reloads the page**. Adding acceptors down the whole
 * re-export chain would be a large, invasive change for a dependency-free
 * package, so we don't; we make the *turn* survive the reload instead.
 *
 * Two teardown shapes, two mechanisms:
 *  - **Soft remount** (the app does `document.body.innerHTML = …`; the mount
 *    module's MutationObserver re-runs `mountIntentTool`): `window` survives, so
 *    the {@link durable} in-memory copy is adopted silently — nothing was lost.
 *  - **Full reload** (an overlay-source edit under the dev server; a Vite config
 *    change; a manual reload; a hard navigation mid-turn): `window` — and the
 *    durable registry with it — is wiped, so we fall back to a
 *    **sessionStorage** mirror, bounded by freshness (5 min), and restore it on
 *    the fresh mount with a status line. There is deliberately NO same-URL
 *    gate: sessionStorage is already same-tab + same-origin (≈ "same app" under
 *    a dev server), and with in-turn navigation a first-class event
 *    (navigation.ts) a turn may legitimately end its life on a different URL
 *    than it started — the recovered turn reports its last URL so the adopter
 *    can record the boundary as a `navigation` event instead of refusing.
 *    (The old exact-URL gate made every cross-page recovery silently fail —
 *    docs/proposals/spa-navigation-and-turn-continuity.md, gotcha #5.)
 *
 * What is precious is only the *turn*: the current thread's event log (which is
 * the transcript, the shot references, and the thread state) — nothing else. The
 * config delta is already persisted separately (advanced-config → localStorage),
 * and the shot pixels / capture grant / live socket die with the page by
 * construction (documented degradation, same as the no-capture path).
 */

import type { IntentEvent } from "@habemus-papadum/aiui-lowering-pipeline";
import { durable } from "./durable";

/** sessionStorage key for the reload-survivable turn mirror (per tab). */
export const TURN_STORAGE_KEY = "aiui-intent-turn";
/** A mirrored turn older than this is treated as stale and ignored. */
const FRESH_MS = 5 * 60_000;

/** The reload-survivable shape written to sessionStorage. */
interface PersistedTurn {
  events: IntentEvent[];
  threadOpen: boolean;
  url: string;
  savedAt: number;
}

/** What {@link TurnStore.recover} hands back, tagged with how it survived. */
export interface RecoveredTurn {
  events: IntentEvent[];
  threadOpen: boolean;
  /** `"live"` — a soft remount adopted the in-memory copy (silent); `"reloaded"`
   * — a full reload restored it from sessionStorage (announce it). */
  source: "live" | "reloaded";
  /** `location.href` when the turn was last recorded. When it differs from the
   * adopting page's URL, a hard navigation happened mid-turn — record it as a
   * `navigation` event so the boundary shows in the stream. */
  url: string;
}

function session(): Storage | undefined {
  return typeof sessionStorage === "undefined" ? undefined : sessionStorage;
}
function currentUrl(): string {
  return typeof location === "undefined" ? "" : location.href;
}

function readMirror(): PersistedTurn | undefined {
  try {
    const raw = session()?.getItem(TURN_STORAGE_KEY);
    if (!raw) {
      return undefined;
    }
    const parsed = JSON.parse(raw) as PersistedTurn;
    return parsed && Array.isArray(parsed.events) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The one turn store for a page — held in the {@link durable} registry so a soft
 * remount adopts the same instance, and mirrored to sessionStorage so a full
 * reload can still recover.
 */
export class TurnStore {
  private live: PersistedTurn | undefined;

  /** Record the current thread's events (the modality calls this per event). */
  record(events: IntentEvent[], threadOpen: boolean): void {
    this.live = { events, threadOpen, url: currentUrl(), savedAt: Date.now() };
    // Mirror synchronously (not debounced): a dev-server reload can fire in the
    // same tick as the file save, and the write is cheap.
    try {
      session()?.setItem(TURN_STORAGE_KEY, JSON.stringify(this.live));
    } catch {
      // private mode / no storage — the in-memory copy still covers soft remounts.
    }
  }

  /** Forget the turn (thread closed — send or cancel — so nothing to recover). */
  clear(): void {
    this.live = undefined;
    try {
      session()?.removeItem(TURN_STORAGE_KEY);
    } catch {
      // no-op
    }
  }

  /**
   * The turn to adopt on a fresh mount, or undefined. A live in-memory turn
   * (soft remount) wins and is silent; otherwise a fresh sessionStorage mirror
   * (full reload — possibly on a different URL, see the module doc) is
   * announced by the caller.
   */
  recover(): RecoveredTurn | undefined {
    if (this.live && this.live.events.length > 0 && this.live.threadOpen) {
      return { events: this.live.events, threadOpen: true, source: "live", url: this.live.url };
    }
    const mirror = readMirror();
    if (mirror?.threadOpen && mirror.events.length > 0 && Date.now() - mirror.savedAt < FRESH_MS) {
      return { events: mirror.events, threadOpen: true, source: "reloaded", url: mirror.url };
    }
    return undefined;
  }
}

/** The page's durable turn store, adopted across soft remounts. */
export function intentTurnStore(): TurnStore {
  return durable("intent-turn", () => new TurnStore());
}
