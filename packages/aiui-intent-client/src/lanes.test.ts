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

describe("config consumers", () => {
  it("panelIntentConfig maps the stt models onto tiers (salvaged mapping)", () => {
    expect(panelIntentConfig("scribe-v2").transcriber).toBe("elevenlabs");
    expect(panelIntentConfig("gpt-4o-transcribe").model).toBe("gpt-4o-transcribe");
    expect(panelIntentConfig("gpt-4o-transcribe").transcriber).toBe("openai-realtime"); // premium
    expect(panelIntentConfig("gpt-4o-mini-transcribe").transcriber).toBe("openai-realtime");
    // rapid no longer pins a transcriber — a tier is its audio-back posture
    expect(panelIntentConfig("gpt-realtime-whisper").audioBack).toBe("off");
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
});
