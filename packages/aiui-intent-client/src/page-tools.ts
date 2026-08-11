/**
 * page-tools.ts — the panel's own LOCAL view of the driven page's tools (O3b of
 * the intent-oracle proposal, git history).
 *
 * The page-tools bridge already exists twice over: pages populate
 * `window.__AIUI__.tools` and the page scripts relay descriptor changes up as
 * `pageTools` events, while `tools-link.ts` represents those pages to the
 * CHANNEL's tool directory (one socket per tab, so the agent behind the
 * channel can call them). This module is the second consumer of that same
 * event stream — the one that keeps the descriptors HERE, so the panel's own
 * oracle can hold the app's tools without a round trip through the channel and
 * back.
 *
 * Deliberately independent of tools-link rather than layered on it: that module
 * owns a socket lifecycle (dial, re-dial, register, close-means-forget) which
 * has nothing to do with a local reader, and entangling them would tie the
 * oracle's tool surface to the health of a channel socket it never uses.
 *
 * The one place the two consumers MUST agree is the `callId` space. Both issue
 * `toolsCall` on the same page and both hear every `toolsResult`, so ours are
 * prefixed and each side ignores a result it did not issue (tools-link's
 * pending map misses ours; ours misses ns/name-shaped directory ids). Same
 * page, same capability, two independent callers, no crossed wires.
 */

import type { IntentHost } from "./transport";

/** One tool the page registered, as its descriptor travels (never a function). */
export interface PageToolDescriptor {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
}

/** A namespace's worth of registrations, as `pageTools` reports them.
 * `active` is the namespace's activity bit (absent = active): the oracle's
 * projection filters on it, the ledger renders it. */
export interface PageToolNamespace {
  ns: string;
  tools: PageToolDescriptor[];
  active?: boolean;
}

export interface PageToolsRegistry {
  /** What the given tab currently registers (empty when it has no tools). */
  toolsFor(tab: number | undefined): PageToolNamespace[];
  /**
   * Invoke one tool in the page and await its answer. Rejects when the page is
   * unreachable, when the tab reports a failure, or after `timeoutMs` — a
   * voice conversation cannot wait on a page that never answers.
   */
  call(tab: number, ns: string, name: string, args: Record<string, unknown>): Promise<unknown>;
  /** Fires whenever any tab's registrations change (add, replace, or clear). */
  onChange(listener: () => void): () => void;
  /** Ask a tab to re-announce (idempotent per tab; see the note in the impl). */
  ask(tab: number | undefined): void;
  dispose(): void;
}

export interface PageToolsOptions {
  host: IntentHost;
  /** How long to wait for a `toolsResult` before giving up. Default 15s. */
  timeoutMs?: number;
}

/** Ours, and recognizably ours — see the callId note in the module doc. */
const CALL_PREFIX = "panel_";
const DEFAULT_TIMEOUT_MS = 15_000;

export function createPageTools(options: PageToolsOptions): PageToolsRegistry {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const byTab = new Map<number, PageToolNamespace[]>();
  const listeners = new Set<() => void>();
  const pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  let seq = 0;

  const announce = (): void => {
    for (const listener of listeners) {
      listener();
    }
  };

  const settle = (
    callId: string,
  ): { resolve: (v: unknown) => void; reject: (e: Error) => void } | undefined => {
    const entry = pending.get(callId);
    if (entry === undefined) {
      return undefined;
    }
    clearTimeout(entry.timer);
    pending.delete(callId);
    return entry;
  };

  const offPage = options.host.transport.onPageEvent((event) => {
    if (event.kind === "pageTools") {
      // The event carries the tab's FULL current set, so this is a replace —
      // an empty one means the page unloaded its last tool and the tab simply
      // has none (never a reason to keep stale descriptors around).
      if (event.registrations.length === 0) {
        if (byTab.delete(event.tab)) {
          announce();
        }
        return;
      }
      byTab.set(event.tab, event.registrations as PageToolNamespace[]);
      announce();
      return;
    }
    if (event.kind === "tabClosed") {
      // The tab is gone for good — drop its descriptors AND its asked mark
      // (tab ids can be recycled by the fake tier; a real id never is, and
      // clearing costs nothing).
      asked.delete(event.tab);
      if (byTab.delete(event.tab)) {
        announce();
      }
      return;
    }
    if (event.kind === "toolsResult") {
      const entry = settle(event.callId);
      if (entry === undefined) {
        return; // not ours — the channel directory's, or already timed out
      }
      if (event.ok) {
        entry.resolve(event.value);
      } else {
        entry.reject(new Error(event.error ?? "the page tool failed"));
      }
    }
  });

  // ASK, rather than wait to be told (owner, 2026-07-30). Registrations were
  // broadcast-only: a page announces at injection and on change, so a panel
  // opened later — or reloaded, or whose bus subscribed a tick after the
  // announcement — believed an instrumented page had no tools, permanently and
  // silently. Every attempted fix on the broadcast side just relocated the
  // race. So whenever the tab in view is one we hold nothing for, we ask it;
  // the answer arrives as an ordinary `pageTools` event, so there is still one
  // delivery path and one shape.
  //
  // Asked ONCE per tab per registry: a page with genuinely no tools answers
  // with an empty set and must not be re-asked on every glance, and a page
  // that later registers some announces on its own.
  const asked = new Set<number>();
  const askFor = (tab: number | undefined): void => {
    if (tab === undefined || asked.has(tab) || byTab.has(tab)) {
      return;
    }
    asked.add(tab);
    void options.host.transport.requestPage(tab, "toolsRefresh", undefined).catch(() => {
      // A tab with no content script (chrome://, the store, a PDF) simply has
      // nothing to answer — not a fault, and not worth a retry.
    });
  };
  const offTab = options.host.targeting.onActiveTabChange(askFor);
  askFor(options.host.targeting.activeTab());

  return {
    toolsFor: (tab) => (tab === undefined ? [] : (byTab.get(tab) ?? [])),
    ask: askFor,
    call: (tab, ns, name, args) =>
      new Promise<unknown>((resolve, reject) => {
        const callId = `${CALL_PREFIX}${++seq}`;
        const timer = setTimeout(() => {
          if (settle(callId) !== undefined) {
            reject(new Error(`${ns}/${name} did not answer within ${timeoutMs}ms`));
          }
        }, timeoutMs);
        pending.set(callId, { resolve, reject, timer });
        void options.host.transport
          .requestPage(tab, "toolsCall", { ns, name, args, callId })
          .catch((error: unknown) => {
            // The REQUEST failed (no content script, tab gone) — distinct from
            // the tool running and failing, which comes back as a result.
            if (settle(callId) !== undefined) {
              reject(error instanceof Error ? error : new Error(String(error)));
            }
          });
      }),
    onChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose: () => {
      offPage();
      offTab();
      for (const [callId] of pending) {
        settle(callId)?.reject(new Error("the panel closed"));
      }
      listeners.clear();
      byTab.clear();
    },
  };
}
