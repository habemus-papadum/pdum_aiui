// @vitest-environment jsdom
/**
 * lanes.test.ts — the REAL lanes (shared Engine + createWire + the frame
 * pump) driven through the full client over the FakeBus, with only the
 * network seam stubbed (OpenThread → an in-memory thread that records
 * chunks). These are the Phase-2 acceptance rows: the wire engine is
 * DRIVEN by the mode engine and its world flows back as events — no dual
 * truth, no hand-sync.
 */
import { disposeDurable } from "@habemus-papadum/aiui-viz";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activationGesture } from "./activation";
import { createIntentClient, type IntentClient } from "./client";
import { linter, stt } from "./config";
import { type FakeBus, fakeBus } from "./fake-bus";
import {
  type ChannelLanes,
  createChannelLanes,
  currentThreadEvents,
  panelIntentConfig,
} from "./lanes";
import { intentSpec } from "./spec";

const settle = async (rounds = 16): Promise<void> => {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
};

/** An in-memory IntentThread: records every chunk the wire sends. */
interface StubThread {
  chunks: Array<{ kind: string; payload?: unknown; fin?: boolean }>;
  dials: Array<Record<string, unknown>>;
  serverPush?: (msg: unknown) => void;
  closed: boolean;
}

function stubThread(): { thread: StubThread; openThread: never } {
  const thread: StubThread = { chunks: [], dials: [], closed: false };
  const ack = Promise.resolve({ ok: true });
  const openThread = (async (options: {
    url: string;
    meta: Record<string, unknown>;
    onServerMessage: (msg: unknown) => void;
  }) => {
    thread.dials.push(options.meta);
    thread.serverPush = options.onServerMessage;
    return {
      send: (payload: unknown) => {
        thread.chunks.push({ kind: "send", payload });
        return ack;
      },
      finish: (payload?: unknown) => {
        thread.chunks.push({ kind: "finish", payload, fin: true });
        return ack;
      },
      sendChunk: (chunk: { kind?: string }, payload: unknown, fin?: boolean) => {
        thread.chunks.push({ kind: `chunk:${chunk.kind ?? "?"}`, payload, fin });
        return ack;
      },
      sendAttachment: (chunk: { id?: string }, _bytes: Uint8Array, fin?: boolean) => {
        thread.chunks.push({ kind: `attachment:${chunk.id ?? "?"}`, fin });
        return ack;
      },
      sendAudio: () => {
        thread.chunks.push({ kind: "audio" });
        return ack;
      },
      sendVideo: () => {
        thread.chunks.push({ kind: "video" });
        return ack;
      },
      onServerMessage: () => {},
      close: () => {
        thread.closed = true;
      },
    };
  }) as never;
  return { thread, openThread };
}

interface Rig {
  client: IntentClient;
  bus: FakeBus;
  lanes: ChannelLanes;
  thread: StubThread;
  toasts: string[];
  lowered: string[];
  unbind: () => void;
}

let rig: Rig | undefined;

function makeRig(): Rig {
  const bus = fakeBus({ activeTab: 7 });
  const { thread, openThread } = stubThread();
  const toasts: string[] = [];
  const lowered: string[] = [];
  const lanes = createChannelLanes({
    host: bus,
    port: () => 55555,
    tabMeta: async () => ({ url: "http://page.example/", title: "page" }),
    openThread,
    onToast: (m) => toasts.push(m),
    onLoweredPrompt: (p) => lowered.push(p),
  });
  const client = createIntentClient({
    host: bus,
    lanes: lanes.lanes,
    claimOptions: lanes.claimOptions,
  });
  const unbind = lanes.bind(client);
  client.setContext({ connected: true });
  rig = { client, bus, lanes, thread, toasts, lowered, unbind };
  return rig;
}

afterEach(async () => {
  rig?.unbind();
  await rig?.client.dispose();
  rig = undefined;
  for (const region of Object.values(intentSpec.regions)) {
    if (region.agent !== undefined) {
      disposeDurable(`control:${region.agent}`);
    }
  }
  for (const region of Object.keys(intentSpec.regions)) {
    disposeDurable(`mode:${region}`);
  }
  vi.restoreAllMocks();
});

describe("the region drag (the `a` area shot)", () => {
  it("arms the page, then a regionDrag event crops, composes, and uploads", async () => {
    const r = makeRig();
    activationGesture(r.client, 7);
    r.client.dispatch("region");
    await settle();
    // The page was armed for ONE drag.
    expect(r.bus.log.some((line) => line.startsWith("page:region@7"))).toBe(true);

    // The user drags a 200×100 region at (10,20); the page reports it with
    // located components (an aiui-instrumented page).
    r.bus.firePageEvent({
      kind: "regionDrag",
      tab: 7,
      rect: { x: 10, y: 20, w: 200, h: 100 },
      viewport: { w: 1000, h: 800 },
      takenAt: Date.now(),
      components: [{ component: "LegendBox", source: "src/Legend.tsx:12:3" }],
    });
    await settle(30);

    // Cropped through the host's region path (never the full frame)…
    expect(r.bus.log.some((line) => line.startsWith("region@7 200x100@10,20"))).toBe(true);
    // …composed as a shot whose rect and components are the drag's…
    const shot = r.lanes.engine.events.find((e) => e.type === "shot");
    expect(shot).toBeDefined();
    expect(shot?.type === "shot" && shot.rect).toEqual({ x: 10, y: 20, w: 200, h: 100 });
    expect(shot?.type === "shot" && shot.components).toHaveLength(1);
    // …and uploaded as the marker's attachment.
    await settle(30);
    expect(r.thread.chunks.some((c) => c.kind.startsWith("attachment:shot_"))).toBe(true);
  });
});

describe("the wire engine is DRIVEN — one machine, no dual truth", () => {
  it("activation opens a real thread; the hello meta carries tab + actor + config", async () => {
    const r = makeRig();
    activationGesture(r.client, 7);
    expect(r.lanes.engine.threadOpen).toBe(true); // the wire engine followed
    r.client.dispatch("ink"); // a contentful event so the wire dials
    await settle(30);
    expect(r.thread.dials.length).toBeGreaterThan(0);
    const meta = r.thread.dials[0];
    expect(meta.actor).toBe("human");
    expect((meta.tab as { url: string }).url).toBe("http://page.example/");
    // stt/linter reached the engine's declared config (read at construction)
    expect((meta.intent as { transcriber: string }).transcriber).toBe("elevenlabs"); // scribe-v2 default
  });

  it("send with content lowers and closes; the seat stays armed", async () => {
    const r = makeRig();
    activationGesture(r.client, 7);
    r.lanes.engine.contribute("hello from the harness"); // turn content
    await settle(30);
    r.client.dispatch("send");
    await settle(30);
    expect(r.client.state().phase).toBe("armed");
    expect(r.lanes.engine.threadOpen).toBe(false); // closed with reason "send"
    expect(r.thread.chunks.some((c) => c.fin === true)).toBe(true); // the fin frame went out
  });

  it("send on an EMPTY explicit turn cancels instead (nothing to lower)", async () => {
    const r = makeRig();
    activationGesture(r.client, 7);
    r.client.dispatch("send");
    await settle();
    expect(r.client.state().phase).toBe("armed");
    expect(r.lanes.engine.threadOpen).toBe(false); // stepOut — reason "cancel"
  });

  it("the wire closing the thread flows BACK: engine timeout → mode engine armed", async () => {
    const r = makeRig();
    activationGesture(r.client, 7);
    expect(r.client.state().phase).toBe("turn");
    // The server/timeout side: the wire engine closes its thread itself.
    r.lanes.engine.stepOut();
    await settle();
    expect(r.client.state().phase).toBe("armed"); // turnClosed binding fired
  });

  it("a lowered-prompt push reaches the page; channel errors reach the toast line", async () => {
    const r = makeRig();
    activationGesture(r.client, 7);
    r.client.dispatch("ink");
    await settle(30);
    r.thread.serverPush?.({ kind: "lowered-prompt", prompt: "LOWERED" });
    r.thread.serverPush?.({ kind: "error", message: "no such model", source: "channel" });
    expect(r.lowered).toEqual(["LOWERED"]);
    expect(r.toasts).toContain("channel: no such model");
  });
});

describe("shots and selections ride the wire", () => {
  it("a manual shot grabs, flashes (shotFlash gate), and uploads the attachment", async () => {
    const r = makeRig();
    activationGesture(r.client, 7);
    await settle();
    r.client.dispatch("shot");
    await settle(30);
    expect(r.bus.log.some((l) => l.startsWith("shot@7"))).toBe(true);
    expect(r.bus.log).toContain('page:flash@7 {"kind":"shot"}'); // manual → flash
    expect(r.thread.chunks.some((c) => c.kind.startsWith("attachment:shot_"))).toBe(true);
    expect(r.lanes.engine.events.some((e) => e.type === "shot")).toBe(true);
  });

  it("sampled frames flow through the pump — and NEVER flash", async () => {
    vi.useFakeTimers();
    try {
      const r = makeRig();
      activationGesture(r.client, 7);
      r.client.dispatch("video"); // constant-cadence would wait videoPeriodSec;
      r.client.dispatch("fpsMode"); // smart mode ticks at 1 s with the gate
      await vi.advanceTimersByTimeAsync(50); // claims settle
      r.client.dispatch("fpsMode"); // back to smart (1 s tick)
      r.bus.firePageEvent({ kind: "interaction", tab: 7 }); // arm the gate
      await vi.advanceTimersByTimeAsync(1100);
      expect(r.bus.log.filter((l) => l.startsWith("shot@7")).length).toBeGreaterThan(0);
      expect(r.bus.log.filter((l) => l.includes("flash")).length).toBe(0); // never flash
      expect(r.thread.chunks.some((c) => c.kind.startsWith("attachment:shot_"))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stopping video stops the pump (claim release = sampler stop)", async () => {
    vi.useFakeTimers();
    try {
      const r = makeRig();
      activationGesture(r.client, 7);
      r.client.dispatch("video");
      await vi.advanceTimersByTimeAsync(50);
      r.client.dispatch("video"); // off — release stops the sampler
      await vi.advanceTimersByTimeAsync(20);
      const shots = r.bus.log.filter((l) => l.startsWith("shot@7")).length;
      await vi.advanceTimersByTimeAsync(5000);
      expect(r.bus.log.filter((l) => l.startsWith("shot@7")).length).toBe(shots); // no new ticks
    } finally {
      vi.useRealTimers();
    }
  });

  it("add selection pulls from the page and feeds the engine (pull model)", async () => {
    const r = makeRig();
    activationGesture(r.client, 7);
    await settle();
    r.client.dispatch("selection");
    await settle(30);
    // FakeBus answers undefined → the pull reports, engine untouched
    expect(r.lanes.engine.events.some((e) => e.type === "app-selection")).toBe(false);
  });
});

describe("navigation continuity — context riding the turn", () => {
  it("a same-tab navigation event lands in the engine stream (prompt-rendered)", async () => {
    const r = makeRig();
    activationGesture(r.client, 7);
    r.bus.firePageEvent({
      kind: "navigation",
      tab: 7,
      from: "fake://tab/7/a",
      to: "fake://tab/7/b",
      navKind: "push",
    });
    const nav = r.lanes.engine.events.find((e) => e.type === "navigation") as
      | { from: string; to: string; kind?: string }
      | undefined;
    expect(nav).toMatchObject({ from: "fake://tab/7/a", to: "fake://tab/7/b", kind: "push" });
  });

  it("a tab SWITCH mid-turn is its OWN event (tab-switch), not a navigation, naming both sides and both tabs", async () => {
    const r = makeRig();
    r.bus.setTabUrl(7, "fake://tab/7/docs");
    r.bus.setTabUrl(9, "fake://tab/9/app");
    activationGesture(r.client, 7);
    await settle(); // seed lastActiveTab
    r.bus.switchTab(9);
    await settle(20);
    // A tab switch is a distinct boundary — no `navigation` event is minted.
    expect(r.lanes.engine.events.some((e) => e.type === "navigation")).toBe(false);
    const sw = r.lanes.engine.events.find((e) => e.type === "tab-switch") as
      | { from: string; to: string; fromTab?: number; toTab?: number }
      | undefined;
    expect(sw).toMatchObject({
      from: "fake://tab/7/docs",
      to: "fake://tab/9/app",
      fromTab: 7,
      toTab: 9,
    });
  });

  it("boundaries OUTSIDE a turn record nothing (never a turn opener)", async () => {
    const r = makeRig();
    r.client.setContext({ connected: true });
    r.bus.firePageEvent({ kind: "navigation", tab: 7, from: "a", to: "b" });
    r.bus.switchTab(9);
    await settle(20);
    expect(r.lanes.engine.events.some((e) => e.type === "navigation")).toBe(false);
    expect(r.lanes.engine.events.some((e) => e.type === "tab-switch")).toBe(false);
  });
});

describe("the fade re-relay effect", () => {
  it("re-relays a moved fade while ink is claimed — with NO untracked handler reads", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = makeRig();
    activationGesture(r.client, 7);
    r.client.dispatch("ink");
    await settle(30); // ink claim active → the effect asserts once
    r.bus.clearLog();

    const { inkFade, inkVanish } = await import("./config");
    inkVanish.set(true as never);
    inkFade.set(9 as never);
    await settle(30);
    expect(r.bus.log).toContain('page:ink@7 {"on":true,"fadeSec":9}'); // live re-relay

    // Regression (found live): grantedTab was read in the effect HANDLER —
    // untracked, STRICT_READ_UNTRACKED on every run. Everything the handler
    // needs must arrive through the compute.
    const diagnostics = [...warn.mock.calls, ...error.mock.calls]
      .flat()
      .filter((arg) => typeof arg === "string" && arg.includes("STRICT_READ_UNTRACKED"));
    expect(diagnostics).toEqual([]);
    inkVanish.set(false as never);
    inkFade.set(6 as never);
  });
});

describe("the pencil surface follows the turn and the tab in view", () => {
  it("engages on turn open, re-relays fade live, hands off across a tab switch, disengages on close", async () => {
    const r = makeRig();
    activationGesture(r.client, 7); // grant + arm + turn on tab 7
    await settle(30);
    // Engaged on the tab in view, permanent by default (fade 0).
    expect(r.bus.log).toContain('page:pencil@7 {"op":"engage","fadeSec":0}');
    r.bus.clearLog();

    // Vanishing on + a fade move → a LIVE fade re-relay (already engaged, same tab).
    const { pencilFade } = await import("./config");
    r.client.dispatch("pencilVanish");
    pencilFade.set(9 as never);
    await settle(30);
    expect(r.bus.log).toContain('page:pencil@7 {"op":"fade","fadeSec":9}');
    r.bus.clearLog();

    // A tab switch hands the surface off: disengage the old, engage the new.
    r.bus.switchTab(9);
    await settle(30);
    expect(r.bus.log).toContain('page:pencil@7 {"op":"disengage"}');
    expect(r.bus.log.some((l) => l.startsWith('page:pencil@9 {"op":"engage"'))).toBe(true);
    r.bus.clearLog();

    // Leaving the turn disengages (nothing outlives it).
    r.client.dispatch("disarm");
    await settle(30);
    expect(r.bus.log).toContain('page:pencil@9 {"op":"disengage"}');
    pencilFade.set(6 as never);
  });
});

describe("turn recovery — the mirror", () => {
  it("a mirrored open turn survives a 'reload': events replayed, wire re-dialed, machine re-opened", async () => {
    // One shared in-memory mirror = the surviving sessionStorage.
    let saved: { events: never[]; threadOpen: boolean } | undefined;
    const mirror = {
      persist: (events: never[], threadOpen: boolean) => {
        saved = threadOpen && events.length > 0 ? { events, threadOpen } : undefined;
      },
      recover: () => saved,
    };

    // Page 1: open a turn with content, then "reload" (no send, no cancel).
    const bus1 = fakeBus({ activeTab: 7 });
    const stub1 = stubThread();
    const lanes1 = createChannelLanes({
      host: bus1,
      port: () => 55555,
      openThread: stub1.openThread,
      mirror,
    });
    const client1 = createIntentClient({
      host: bus1,
      lanes: lanes1.lanes,
      claimOptions: lanes1.claimOptions,
    });
    lanes1.bind(client1);
    client1.setContext({ connected: true });
    activationGesture(client1, 7);
    lanes1.engine.contribute("half-composed thought");
    await settle(20);
    expect(saved?.threadOpen).toBe(true);
    await client1.dispose(); // the page dies mid-turn

    // Page 2: fresh everything except the mirror.
    const bus2 = fakeBus({ activeTab: 7 });
    const stub2 = stubThread();
    const lanes2 = createChannelLanes({
      host: bus2,
      port: () => 55555,
      openThread: stub2.openThread,
      mirror,
    });
    const client2 = createIntentClient({
      host: bus2,
      lanes: lanes2.lanes,
      claimOptions: lanes2.claimOptions,
    });
    const unbind2 = lanes2.bind(client2);
    // The real sequence: the session bus connects, THEN the mirror is recovered
    // (re-arming goes through the ordinary gated `arm` command, and a turn you
    // cannot send is not a turn you have recovered — see lanes.recover).
    client2.setContext({ connected: true });
    expect(lanes2.recover(client2)).toBe(true);
    await settle(30);

    expect(client2.state().phase).toBe("turn"); // the machine re-opened
    expect(lanes2.engine.threadOpen).toBe(true);
    expect(
      lanes2.engine.events.some(
        (e) => e.type === "transcript-final" && (e as { text?: string }).text?.includes("half"),
      ),
    ).toBe(true); // the content survived
    expect(stub2.thread.dials.length).toBeGreaterThan(0); // the wire re-dialed

    unbind2();
    await client2.dispose();
    rig = undefined;
  });

  it("no mirrored turn (or a closed one) recovers nothing", () => {
    const r = makeRig(); // makeRig's lanes use the DEFAULT sessionStorage mirror
    sessionStorage.removeItem("aiui2.turn");
    expect(r.lanes.recover(r.client)).toBe(false);
    expect(r.client.state().phase).toBe("disarmed");
  });
});

describe("config consumers", () => {
  it("panelIntentConfig maps the stt models onto tiers (salvaged mapping)", () => {
    expect(panelIntentConfig("scribe-v2").transcriber).toBe("elevenlabs");
    expect(panelIntentConfig("gpt-4o-transcribe").model).toBe("gpt-4o-transcribe");
    expect(panelIntentConfig("gpt-4o-transcribe").transcriber).toBe("openai-realtime"); // premium
    expect(panelIntentConfig("gpt-4o-mini-transcribe").transcriber).toBe("openai-realtime");
    // rapid no longer pins a transcriber — a tier is its audio-back posture
    expect(panelIntentConfig("gpt-realtime-whisper").audioBack).toBe("off");
    // …and in the PANEL, no tier speaks a "sent" ack (sends confirm visually).
    expect(panelIntentConfig("scribe-v2").audioBack).toBe("off");
    expect(panelIntentConfig("gpt-4o-mini-transcribe").audioBack).toBe("off");
    expect(panelIntentConfig("scribe-v2", "openai").linter).toBe("openai");
    expect(panelIntentConfig("scribe-v2", "off").linter).toBe("off"); // the default
  });

  it("currentThreadEvents slices from the last thread-open", () => {
    const r = makeRig();
    activationGesture(r.client, 7);
    r.lanes.engine.contribute("one");
    const events = currentThreadEvents(r.lanes.engine.events);
    expect(events[0]?.type).toBe("thread-open");
    // contribute() rides the transcript lane (model: "contribution")
    expect(events.some((e) => e.type === "transcript-final")).toBe(true);
  });

  it("the stt/linter selects re-apply LIVE — the next hello (and the clip gate) see them", async () => {
    const r = makeRig();
    try {
      // Boot: linter off, scribe-v2 = premium STT (ttsModel rides along) —
      // but NEVER spoken acks (the panel confirms sends visually).
      expect(r.lanes.engine.settings.linter).toBe("off");
      expect(r.lanes.engine.settings.audioBack).toBe("off");
      expect(r.lanes.engine.settings.ttsModel).toBe("gpt-4o-mini-tts");

      // The user flips the selects mid-session. This used to be boot-frozen:
      // the engine's settings were built once at construction, so the linter
      // never reached the next hello and the wire's lint_-clip gate stayed
      // reading "off" — the silent-linter bug, panel edition.
      linter.set("gemini");
      stt.set("gpt-realtime-whisper");
      await settle();
      expect(r.lanes.engine.settings.linter).toBe("gemini");
      // The premium-only keys are SCRUBBED, not left frozen on the live object.
      expect(r.lanes.engine.settings.ttsModel).toBeUndefined();

      // The next thread's hello declares the new config (openThread reads it fresh).
      activationGesture(r.client, 7);
      r.client.dispatch("ink");
      await settle(30);
      expect((r.thread.dials[0]?.intent as { linter?: string }).linter).toBe("gemini");
    } finally {
      linter.set("off");
      stt.set("scribe-v2");
    }
  });

  it("changing the linter WHILE a turn is open sends a mid-thread control chunk (live start/stop/swap)", async () => {
    const r = makeRig();
    try {
      activationGesture(r.client, 7); // opens a turn → thread-open → socket dialed
      await settle(30);
      expect(r.lanes.engine.threadOpen).toBe(true);
      const before = r.thread.chunks.length;

      linter.set("gemini");
      await settle(30);
      const control = r.thread.chunks.slice(before).find((c) => c.kind === "chunk:control");
      expect(control?.payload).toEqual({ control: "linter", value: "gemini" });
      expect(control?.fin).toBe(false); // reconfiguration rides the open thread, never fins it
    } finally {
      linter.set("off");
    }
  });

  it("changing the linter with NO open thread sends no control — it rides the next hello", async () => {
    const r = makeRig();
    try {
      expect(r.lanes.engine.threadOpen).toBe(false);
      linter.set("gemini");
      await settle(30);
      expect(r.thread.chunks.some((c) => c.kind === "chunk:control")).toBe(false);
    } finally {
      linter.set("off");
    }
  });
});
