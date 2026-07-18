// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  ACTOR_STORAGE_KEY,
  collectClientMeta,
  getInstrumentation,
  pageTabRecord,
} from "./instrumentation";

afterEach(() => {
  window.__AIUI__ = undefined;
});

describe("page instrumentation (window.__AIUI__)", () => {
  it("creates the versioned global lazily", () => {
    expect(window.__AIUI__).toBeUndefined();
    expect(getInstrumentation()).toEqual({ v: 1 });
    expect(getInstrumentation()).toBe(window.__AIUI__);
  });
});

describe("pageTabRecord (the canonical tab record, shared by both hosts)", () => {
  it("reports url + title, and no aiui flag on a plain page", () => {
    document.title = "plain";
    expect(pageTabRecord()).toEqual({ url: location.href, title: "plain" });
  });

  it("detects an aiui app from the page-realm global, source root included", () => {
    window.__AIUI__ = { v: 1, sourceRoot: "/repo/app" };
    expect(pageTabRecord()).toMatchObject({ aiui: true, sourceRoot: "/repo/app" });
  });

  it("detects an aiui app from the DOM footprint when the global is invisible (isolated world)", () => {
    const el = document.createElement("div");
    el.setAttribute("data-source-loc", "src/App.tsx:1:1");
    document.body.append(el);
    try {
      const record = pageTabRecord();
      expect(record?.aiui).toBe(true);
      // sourceRoot lives in the page realm only — absent here by design.
      expect(record?.sourceRoot).toBeUndefined();
    } finally {
      el.remove();
    }
  });

  it("never creates the __AIUI__ global — detection is read-only", () => {
    pageTabRecord();
    expect(window.__AIUI__).toBeUndefined();
  });
});

describe("collectClientMeta", () => {
  it("always reports the page's live url and title", () => {
    document.title = "spectra";
    const meta = collectClientMeta();
    expect(meta?.tab).toEqual({ url: location.href, title: "spectra" });
    expect(meta?.source).toBeUndefined();
  });

  it("merges the plugin's source root", () => {
    window.__AIUI__ = { v: 1, sourceRoot: "/repo/app" };
    const meta = collectClientMeta();
    expect(meta?.tab?.url).toBe(location.href);
    expect(meta?.source).toEqual({ root: "/repo/app" });
  });
});

describe("collectClientMeta: the actor label (trace provenance)", () => {
  afterEach(() => {
    sessionStorage.removeItem(ACTOR_STORAGE_KEY);
  });

  it("defaults to 'human' — never inferred, not even under automation", () => {
    expect(collectClientMeta()?.actor).toBe("human");
  });

  it("honors the per-tab opt-in toggle (ACTOR_STORAGE_KEY)", () => {
    // The explicit flip an agent/CI run makes in the tab it drives. This
    // replaced the navigator.webdriver heuristic, which is browser-wide and
    // labeled the human's own turns "agent" in the shared session browser.
    sessionStorage.setItem(ACTOR_STORAGE_KEY, "agent");
    expect(collectClientMeta()?.actor).toBe("agent");
    sessionStorage.setItem(ACTOR_STORAGE_KEY, "ci-e2e");
    expect(collectClientMeta()?.actor).toBe("ci-e2e");
  });

  it("lets an explicit actor option outrank the tab toggle", () => {
    sessionStorage.setItem(ACTOR_STORAGE_KEY, "agent");
    expect(collectClientMeta({ actor: "bot-7" })?.actor).toBe("bot-7");
  });
});
