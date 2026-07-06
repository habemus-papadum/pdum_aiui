// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  ACTOR_STORAGE_KEY,
  collectClientMeta,
  type FrameMetric,
  getInstrumentation,
  recordFrameMetric,
  setChannelPort,
  TAB_DATASET_KEY,
} from "./instrumentation";
import { connectIntentSocket } from "./protocol";
import { fakeSocketFactory } from "./test-support/fake-socket";

afterEach(() => {
  window.__AIUI__ = undefined;
  delete document.documentElement.dataset[TAB_DATASET_KEY];
});

const metric = (overrides: Partial<FrameMetric> = {}): FrameMetric => ({
  at: Date.now(),
  format: "text-concat",
  kind: "data",
  bytes: 42,
  rttMs: 1,
  ok: true,
  ...overrides,
});

describe("page instrumentation (window.__AIUI__)", () => {
  it("creates the versioned global lazily and publishes the port", () => {
    expect(window.__AIUI__).toBeUndefined();
    setChannelPort(4321);
    expect(window.__AIUI__).toEqual({ v: 1, port: 4321, frames: [] });
    expect(getInstrumentation()).toBe(window.__AIUI__);
  });

  it("keeps the frame ring bounded", () => {
    for (let i = 0; i < 300; i++) {
      recordFrameMetric(metric({ bytes: i }));
    }
    const frames = getInstrumentation()?.frames ?? [];
    expect(frames).toHaveLength(256);
    expect(frames[frames.length - 1].bytes).toBe(299); // newest kept
    expect(frames[0].bytes).toBe(300 - 256); // oldest dropped
  });

  it("is recorded by the protocol client: hello + data frames with size and rtt", async () => {
    const { factory } = fakeSocketFactory(() => ({ ok: true }));
    const socket = await connectIntentSocket("ws://fake/ws", "text-concat", factory);
    await socket.send("t-1", { text: "hello there" }, true);

    const frames = getInstrumentation()?.frames ?? [];
    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({ kind: "hello", format: "text-concat", ok: true });
    expect(frames[1]).toMatchObject({
      kind: "data",
      threadId: "t-1",
      fin: true,
      ok: true,
    });
    for (const f of frames) {
      expect(f.bytes).toBeGreaterThan(0);
      expect(f.rttMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("records failed sends with the error", async () => {
    const { factory } = fakeSocketFactory((_frame, index) =>
      index === 0 ? { ok: true } : { ok: false, error: "thread closed" },
    );
    const socket = await connectIntentSocket("ws://fake/ws", "text-concat", factory);
    await socket.send("t-1", { text: "x" }, false);
    const last = (getInstrumentation()?.frames ?? []).at(-1);
    expect(last).toMatchObject({ ok: false, error: "thread closed" });
  });
});

describe("collectClientMeta", () => {
  it("always reports the page's live url and title", () => {
    document.title = "spectra";
    const meta = collectClientMeta();
    expect(meta?.tab).toEqual({ url: location.href, title: "spectra" });
    expect(meta?.source).toBeUndefined();
  });

  it("merges the extension's tab stamp and the plugin's source root", () => {
    document.documentElement.dataset[TAB_DATASET_KEY] = JSON.stringify({
      chromeTabId: 7,
      windowId: 2,
      tabIndex: 3,
      targetId: "ABC",
    });
    window.__AIUI__ = { v: 1, sourceRoot: "/repo/app", frames: [] };
    const meta = collectClientMeta();
    expect(meta?.tab).toMatchObject({ chromeTabId: 7, windowId: 2, tabIndex: 3, targetId: "ABC" });
    expect(meta?.tab?.url).toBe(location.href);
    expect(meta?.source).toEqual({ root: "/repo/app" });
  });

  it("ignores a malformed or mistyped stamp", () => {
    document.documentElement.dataset[TAB_DATASET_KEY] = "not json {";
    expect(collectClientMeta()?.tab?.chromeTabId).toBeUndefined();

    document.documentElement.dataset[TAB_DATASET_KEY] = JSON.stringify({
      chromeTabId: "7", // wrong type — dropped, the rest kept
      targetId: "ABC",
    });
    const meta = collectClientMeta();
    expect(meta?.tab?.chromeTabId).toBeUndefined();
    expect(meta?.tab?.targetId).toBe("ABC");
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
