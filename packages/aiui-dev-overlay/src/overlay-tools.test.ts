// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { installToolsBridge, TURN_STORAGE_KEY } from "./index";
import { mountIntentTool, unmountIntentTool } from "./intent";
import { validateIntentConfig } from "./multimodal/advanced-config";
import { multimodalModality } from "./multimodal/modality";
import { OVERLAY_TOOLS_NS, type OverlayReport, type OverlayToolsHandle } from "./overlay-tools";
import { fakeSocketFactory } from "./test-support/fake-socket";
import { installLocalStorage } from "./test-support/local-storage";
import { installSessionStorage } from "./test-support/session-storage";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Dispatch a document key event (the capture-phase keymap listens on document). */
function key(type: "keydown" | "keyup", k: string): void {
  document.dispatchEvent(new KeyboardEvent(type, { key: k, bubbles: true }));
}

/** Mount the multimodal modality alone (mock backends), wired to a fake socket. */
function mountMultimodal(config: Parameters<typeof multimodalModality>[0] = {}) {
  const { factory, sent } = fakeSocketFactory(() => ({ ok: true }));
  mountIntentTool({
    force: true,
    port: 4321,
    webSocketFactory: factory,
    modalities: [
      multimodalModality({ transcriber: "mock", mockWordMs: 0, mockTypoRate: 0, ...config }),
    ],
  });
  return { sent };
}

/** The overlay's own agent handle, installed at mount. */
const surface = (): OverlayToolsHandle => {
  const h = window.__aiui_overlay;
  if (!h) {
    throw new Error("overlay tools not installed");
  }
  return h;
};

/** Drive a whole arm·talk·final turn (thread left open — no send). */
async function speakOneSegment(): Promise<void> {
  key("keydown", "`"); // arm
  key("keydown", " "); // talk-start → thread-open → socket opens
  await wait(30);
  key("keyup", " "); // talk-end → mock transcribe → transcript-final
  await wait(60);
}

let uninstallLocal: (() => void) | undefined;
let uninstallSession: (() => void) | undefined;

afterEach(() => {
  unmountIntentTool();
  delete window.__AIUI__;
  window.getSelection?.()?.removeAllRanges();
  uninstallLocal?.();
  uninstallLocal = undefined;
  uninstallSession?.();
  uninstallSession = undefined;
  // Clear any turn a test left in jsdom's (persistent) sessionStorage.
  if (typeof sessionStorage !== "undefined") {
    sessionStorage.clear();
  }
});

describe("the overlay's own agent surface (ns aiui_overlay)", () => {
  it("installs the full tool set next to the widget", () => {
    mountMultimodal();
    const names = surface()
      .tools.map((t) => t.name)
      .sort();
    expect(surface().ns).toBe(OVERLAY_TOOLS_NS);
    expect(names).toEqual([
      "arm",
      "close_panel",
      "disarm",
      "get_config",
      "get_events",
      "open_panel",
      "report",
      "set_config",
    ]);
    // Every tool carries a real object inputSchema.
    for (const tool of surface().tools) {
      expect(tool.inputSchema).toMatchObject({ type: "object" });
    }
  });

  it("report() is a bounded snapshot of armed/mode/thread/channel/selection/capture", () => {
    mountMultimodal();
    const report = surface().call("report") as OverlayReport;
    expect(report).toMatchObject({
      armed: false,
      mode: "ink",
      talking: false,
      threadOpen: false,
      activeModality: "Multimodal",
      panelOpen: false,
      channel: { port: 4321, threadSocket: "none", bridge: "absent" },
      selection: { present: false },
      capture: { grant: "none" },
    });
    // Config is the effective client view, present and unredacted.
    expect(report.config.transcriber).toBe("mock");
    expect(report.events).toEqual({ length: 0, last: [] });
  });

  it("arm / disarm and open_panel / close_panel drive real state through the surface", () => {
    mountMultimodal();
    expect((surface().call("arm") as OverlayReport).armed).toBe(true);
    expect((surface().call("report") as OverlayReport).armed).toBe(true);
    expect((surface().call("disarm") as OverlayReport).armed).toBe(false);

    expect((surface().call("open_panel") as OverlayReport).panelOpen).toBe(true);
    expect((surface().call("close_panel") as OverlayReport).panelOpen).toBe(false);
  });

  it("set_config validates and applies through the SAME path as the advanced panel", () => {
    uninstallLocal = installLocalStorage();
    mountMultimodal();
    const result = surface().call("set_config", {
      config: { transcriber: "mock", talkMode: "toggle" },
    }) as {
      ok: true;
      applied: number;
      config: { talkMode: string };
    };
    expect(result.ok).toBe(true);
    expect(result.config.talkMode).toBe("toggle");
    // It went live…
    expect((surface().call("report") as OverlayReport).config.talkMode).toBe("toggle");
    // …and persisted as the panel's override delta (readable by loadIntentOverrides).
    expect(JSON.parse(localStorage.getItem("aiui-intent-config") ?? "{}")).toMatchObject({
      talkMode: "toggle",
    });
  });

  it("set_config with a typo'd key throws the loud error identical to the panel's", () => {
    uninstallLocal = installLocalStorage();
    mountMultimodal();
    const bad = { notAKey: 1 };
    const expected = validateIntentConfig(bad);
    expect(expected.ok).toBe(false);
    expect(() => surface().call("set_config", { config: bad })).toThrow(
      (expected as { ok: false; error: string }).error,
    );
  });

  it("get_events returns the raw tail after a mock talk", async () => {
    mountMultimodal();
    await speakOneSegment();
    const events = surface().call("get_events", { count: 50 }) as Array<{ type: string }>;
    const types = events.map((e) => e.type);
    expect(types).toContain("thread-open");
    expect(types).toContain("talk-start");
    expect(types).toContain("transcript-final");
    // report()'s event tail agrees on the length.
    expect((surface().call("report") as OverlayReport).events.length).toBe(events.length);
  });
});

describe("aiui_overlay reaches the channel through the tools bridge", () => {
  /** Parse the register frames a fake /tools socket sent. */
  const registers = (sent: string[]) =>
    sent.map((s) => JSON.parse(s)).filter((m) => m.type === "register");

  it("registers over /tools and deregisters (empty set) on unmount", () => {
    window.__AIUI__ = { v: 1, frames: [], port: 5123 };
    const toolsSockets: Array<{ sent: string[]; emit: (t: string, e: unknown) => void }> = [];
    const bridgeDispose = installToolsBridge({
      port: 5123,
      probe: () => "tools",
      socketFactory: () => {
        const sent: string[] = [];
        const listeners = new Map<string, Array<(e: unknown) => void>>();
        const emit = (t: string, e: unknown) => {
          for (const fn of listeners.get(t) ?? []) fn(e);
        };
        toolsSockets.push({ sent, emit });
        return {
          send: (d) => sent.push(d),
          close: () => emit("close", {}),
          addEventListener: (t, l) =>
            listeners.set(t, [...(listeners.get(t) ?? []), l as (e: unknown) => void]),
        };
      },
    });
    const socket = toolsSockets[0];
    socket.emit("open", {}); // connect so declarations flush

    // Mount the widget: the overlay registers its namespace over the bridge.
    mountMultimodal();
    const declared = registers(socket.sent).filter((r) => r.ns === OVERLAY_TOOLS_NS);
    expect(declared.length).toBeGreaterThanOrEqual(1);
    expect(declared.at(-1).tools.map((t: { name: string }) => t.name)).toContain("report");

    // Unmount: the namespace is withdrawn as an empty-set register.
    unmountIntentTool();
    const afterUnmount = registers(socket.sent)
      .filter((r) => r.ns === OVERLAY_TOOLS_NS)
      .at(-1);
    expect(afterUnmount.tools).toEqual([]);
    expect(window.__aiui_overlay).toBeUndefined();
    bridgeDispose();
  });
});

describe("turn recovery across a reload (the pair-programming guarantee)", () => {
  it("mirrors an open turn to sessionStorage and recovers it after a simulated reload", async () => {
    uninstallSession = installSessionStorage();

    // Compose a turn and leave the thread open (no send).
    mountMultimodal();
    await speakOneSegment();
    expect((surface().call("report") as OverlayReport).threadOpen).toBe(true);
    expect(sessionStorage.getItem(TURN_STORAGE_KEY)).not.toBeNull();

    // Simulate a full reload: tear down and wipe window.__AIUI__ (durable
    // registry + port), keeping only sessionStorage — exactly what an
    // overlay-source edit under the dev server does.
    unmountIntentTool();
    delete window.__AIUI__;

    mountMultimodal();
    const report = surface().call("report") as OverlayReport;
    expect(report.armed).toBe(true);
    expect(report.events.length).toBeGreaterThan(0);
    expect(report.status).toContain("recovered an in-progress turn");
  });

  it("adopts a live turn silently on a soft remount (no reload notice)", async () => {
    uninstallSession = installSessionStorage();
    mountMultimodal();
    await speakOneSegment();

    // Soft remount: tear down the modality but KEEP window.__AIUI__ (the durable
    // registry survives, as it would when the app rebuilds document.body).
    unmountIntentTool();
    mountMultimodal();

    const report = surface().call("report") as OverlayReport;
    expect(report.events.length).toBeGreaterThan(0);
    // A live adoption is silent — no "recovered" banner.
    expect(report.status).not.toContain("recovered");
  });
});
