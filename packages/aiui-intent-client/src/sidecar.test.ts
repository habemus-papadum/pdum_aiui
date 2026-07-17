/**
 * sidecar.test.ts — the page bundle's delivery contract: its exports MERGE
 * into `__aiuiIntentPage`, they never replace it. The regression here was
 * found live (2026-07-17): `globalName: PAGE_GLOBAL` assigned the IIFE's
 * exports over the page-script's capability surface, so the moment the bundle
 * landed, `handle` was gone — heartbeats, pencil, and region all evaluated to
 * a swallowed TypeError while the claims read "active". The page-script's
 * install merges in the other direction for the same reason (page-script.ts).
 */
import { describe, expect, it } from "vitest";
import { PAGE_GLOBAL, pageBundle } from "./sidecar";

describe("pageBundle", () => {
  it("MERGES its exports into an existing page global (never clobbers handle)", async () => {
    const source = await pageBundle();

    // Evaluate the bundle against a window that already carries the
    // page-script's surface — exactly the order `ensureBundle` produces.
    const surface: Record<string, unknown> = {
      v: "test-version",
      handle: () => "still here",
    };
    const window: Record<string, unknown> = { [PAGE_GLOBAL]: surface };
    new Function("window", source)(window);

    const global = window[PAGE_GLOBAL] as Record<string, unknown>;
    // Same OBJECT — references held by the page-script stay valid.
    expect(global).toBe(surface);
    // The page-script's surface survived the bundle landing.
    expect(typeof global.handle).toBe("function");
    expect(global.v).toBe("test-version");
    // …and the bundle's exports arrived beside it.
    expect(typeof global.mountPencil).toBe("function");
    expect(typeof global.locateComponents).toBe("function");
    expect(typeof global.armJump).toBe("function");
    // The IIFE's var stays function-scoped — no second global leaks.
    expect(Object.keys(window)).toEqual([PAGE_GLOBAL]);
  });

  it("installs cleanly on a page with NO prior surface (bundle-first order)", async () => {
    const source = await pageBundle();
    const window: Record<string, unknown> = {};
    new Function("window", source)(window);
    const global = window[PAGE_GLOBAL] as Record<string, unknown>;
    expect(typeof global.mountPencil).toBe("function");
  });
});
