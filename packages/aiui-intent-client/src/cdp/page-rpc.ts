/**
 * page-rpc.ts — the page-side delivery machinery for the CdpBus, and the state
 * that rides with it. Every capability reaches a page through the one `evaluate`
 * path (whose throw-on-`exceptionDetails` is load-bearing: a swallowed page
 * throw is how the bundle-clobber bug hid behind "active" claims for a whole
 * tier, found live 2026-07-17). It also owns what the client ASSERTED per tab —
 * the sticky capabilities and the ring desire — so a reload (a NEW document,
 * bare of every page-level assertion) gets them back via `replay`.
 *
 * In cdp-bus this state was free closure capture; here the factory owns it and
 * cdp-bus calls rememberSticky / setRing / forgetTab instead of touching maps.
 *
 * Panel-side only. Never import this from page-script.ts / page-bundle.ts: those
 * are stringified/evaluated INTO arbitrary pages and must stay dependency-free.
 */
import { PAGE_REPORT_BINDING } from "../page/report";
import { type PageCapability, type RingState, ringForTab } from "../transport";
import type { AttachedPage } from "./cdp-bus";
import type { CdpConnection } from "./protocol";

/** Capabilities whose effect lives in the DOCUMENT — replay them on reload. */
const STICKY: ReadonlySet<PageCapability> = new Set(["keylayer"]);

export interface PageRpc {
  /** Deliver one capability to one page — the single path everything takes. */
  apply(page: AttachedPage, capability: PageCapability, payload?: unknown): Promise<unknown>;
  /** Instrument one page session in order (the binding BEFORE the code that
   * calls it, so the bootstrap's hello lands). */
  prepare(sessionId: string): Promise<void>;
  /** Re-run the bootstrap into a document that came back bare after a
   * navigation — idempotent by construction (the install guard turns a second
   * run into `adopt()`). Uses the same throw-on-exception evaluate path. */
  reinject(sessionId: string): Promise<void>;
  /** A document just announced itself: give it back ring + sticky assertions. */
  replay(page: AttachedPage): void;
  /** Record a STICKY capability's latest payload (a no-op for non-sticky ones). */
  rememberSticky(tab: number, capability: PageCapability, payload: unknown): void;
  /** The broadcast ring desire, read by `replay`'s per-tab projection. */
  setRing(state: RingState): void;
  /** Drop a closed tab's sticky assertions. */
  forgetTab(tab: number): void;
}

export interface PageRpcDeps {
  cdp: CdpConnection;
  /** The injectable bootstrap source (`buildPageScript()`). */
  script: string;
  /** Where the page bundle is read from (the panel's own origin). */
  channelOrigin: string;
  /** The page bundle's source (tests override; defaults to the channel route). */
  bundleSource?: () => Promise<string>;
}

export function createPageRpc({ cdp, script, channelOrigin, bundleSource }: PageRpcDeps): PageRpc {
  /** The page bundle, read ONCE from our own origin and re-used for every page. */
  const resolveBundle =
    bundleSource ??
    (() =>
      fetch(`${channelOrigin}/intent/page-bundle.js`).then((res) => {
        if (!res.ok) {
          throw new Error(`the channel could not build the page bundle (${res.status})`);
        }
        return res.text();
      }));
  let pageBundle: Promise<string> | undefined;

  /** What we asserted per tab, so a fresh document gets it back. */
  const sticky = new Map<number, Map<PageCapability, unknown>>();
  let ring: RingState = { on: false, turnTone: false };

  const evaluate = async (sessionId: string, expression: string, awaitPromise = false) => {
    const outcome = (await cdp.send(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise },
      sessionId,
    )) as {
      result?: { value?: unknown };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    };
    // A page-side throw must FAIL the caller, not read as `undefined` — a
    // swallowed TypeError is how the bundle-clobber bug hid behind "active"
    // claims for a whole tier (found live, 2026-07-17).
    if (outcome.exceptionDetails !== undefined) {
      const detail =
        outcome.exceptionDetails.exception?.description ??
        outcome.exceptionDetails.text ??
        "page evaluate threw";
      throw new Error(detail.split("\n")[0]);
    }
    return outcome;
  };

  /** The capability call, as an expression evaluated in the page's own world. */
  const invoke = (capability: PageCapability, payload?: unknown): string =>
    `window.__aiuiIntentPage && window.__aiuiIntentPage.handle(${JSON.stringify(capability)}, ${JSON.stringify(payload ?? null)})`;

  /**
   * The page bundle (locator · jump · pencil), evaluated INTO the page (once
   * per document). The page cannot fetch it: on an https page a module from
   * the channel's http origin is mixed content, so the panel reads the bundle
   * from its own origin and hands over the source. Any page can be marked up;
   * that is the point.
   */
  const ensureBundle = async (page: AttachedPage): Promise<void> => {
    if (page.bundleInjected) {
      return;
    }
    pageBundle ??= resolveBundle();
    await evaluate(page.sessionId, await pageBundle);
    page.bundleInjected = true;
  };

  /** Deliver one capability to one page — the single path everything takes. */
  const apply = async (
    page: AttachedPage,
    capability: PageCapability,
    payload?: unknown,
  ): Promise<unknown> => {
    if (capability === "region" || capability === "jump" || capability === "pencil") {
      // The region drag's locator, the jump picker, and the pencil surface all
      // ride the evaluated bundle — deliver it before the op so instrumented
      // pages can name components / open the picker / draw.
      await ensureBundle(page);
    }
    const result = await evaluate(page.sessionId, invoke(capability, payload));
    return result.result?.value;
  };

  /** A document just announced itself: give it back what we had asserted. */
  const replay = (page: AttachedPage): void => {
    if (ring.on) {
      void apply(page, "ring", ringForTab(ring, page.tab)).catch(() => {});
    }
    for (const [capability, payload] of sticky.get(page.tab) ?? []) {
      void apply(page, capability, payload).catch(() => {});
    }
  };

  const prepare = async (sessionId: string): Promise<void> => {
    await cdp.send("Runtime.enable", {}, sessionId);
    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("Runtime.addBinding", { name: PAGE_REPORT_BINDING }, sessionId);
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: script }, sessionId);
    await evaluate(sessionId, script); // the document already loaded
  };

  const reinject = async (sessionId: string): Promise<void> => {
    await evaluate(sessionId, script);
  };

  return {
    apply,
    prepare,
    reinject,
    replay,
    rememberSticky: (tab, capability, payload) => {
      if (STICKY.has(capability)) {
        const perTab = sticky.get(tab) ?? new Map<PageCapability, unknown>();
        perTab.set(capability, payload);
        sticky.set(tab, perTab);
      }
    },
    setRing: (state) => {
      ring = state;
    },
    forgetTab: (tab) => {
      sticky.delete(tab);
    },
  };
}
