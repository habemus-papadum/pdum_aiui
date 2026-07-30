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
import { linter, oraclePageTools, stt } from "./config";
import { type FakeBus, fakeBus } from "./fake-bus";
import {
  type ChannelLanes,
  type ChannelLanesConfig,
  createChannelLanes,
  currentThreadEvents,
  panelIntentConfig,
} from "./lanes";
import { oracleToolsForTab } from "./lanes/oracle";
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
    // TWO server-message subscribers exist in production: the lanes-level
    // handler (dial options — error toasts, lowered-prompt) and the wire's
    // own thread.onServerMessage subscription (lowered-events ingest,
    // speech). serverPush fans out to both, like the real socket.
    const subscribers: Array<(msg: unknown) => void> = [options.onServerMessage];
    thread.serverPush = (msg) => {
      for (const subscriber of subscribers) {
        subscriber(msg);
      }
    };
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
      onServerMessage: (handler: (msg: unknown) => void) => {
        subscribers.push(handler);
      },
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
  statuses: string[];
  unbind: () => void;
}

let rig: Rig | undefined;

/** The retired one-gesture ritual, recomposed for the grant-only contract
 * (owner, 2026-07-20): the rig's `connected: true` already ARMED the client
 * (arm-on-connect, client.ts), the invocation gesture now only records the
 * grant, and the turn cap opens the turn. */
function grantAndOpen(client: IntentClient, tab: number): void {
  activationGesture(client, tab);
  client.dispatch("turn");
}

function makeRig(): Rig {
  const bus = fakeBus({ activeTab: 7 });
  const { thread, openThread } = stubThread();
  const toasts: string[] = [];
  const statuses: string[] = [];
  const lanes = createChannelLanes({
    host: bus,
    port: () => 55555,
    tabMeta: async () => ({ url: "http://page.example/", title: "page" }),
    openThread,
    onToast: (m) => toasts.push(m),
    onStatus: (line) => statuses.push(line),
    // The alignment snapshot the hello should carry (meta.cdp — the prompt
    // prelude's warn/affirm renders from it channel-side).
    cdpAlignment: () => ({
      state: "aligned" as const,
      boundPort: 55555,
      coDrivers: [{ port: 60001, label: "other :60001" }],
    }),
  });
  const client = createIntentClient({
    host: bus,
    lanes: lanes.lanes,
    claimOptions: lanes.claimOptions,
  });
  const unbind = lanes.bind(client);
  client.setContext({ connected: true });
  rig = { client, bus, lanes, thread, toasts, statuses, unbind };
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
    grantAndOpen(r.client, 7);
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

    // Auto-exit (owner, 2026-07-16): a completed drag flips area mode OFF, and
    // the regionSurface claim lowers the overlay (disarms the page).
    expect(r.client.state().region).toBe(false);
    expect(r.bus.log.some((line) => line === 'page:region@7 {"arm":false}')).toBe(true);
  });
});

describe("the jump-to-editor toggle", () => {
  it("arms the picker on an instrumented page; a jumpDone auto-exits and lowers it", async () => {
    const r = makeRig();
    grantAndOpen(r.client, 7);
    r.bus.firePageEvent({ kind: "aiuiSupport", tab: 7, supported: true });
    r.client.dispatch("jump");
    await settle();
    expect(r.client.state().jump).toBe(true);
    // The jumpSurface claim armed the page picker.
    expect(r.bus.log.some((l) => l.startsWith("page:jump@7"))).toBe(true);

    // The user commits or cancels; the page reports `jumpDone` → auto-exit.
    r.bus.firePageEvent({ kind: "jumpDone", tab: 7 });
    await settle();
    expect(r.client.state().jump).toBe(false);
    expect(r.bus.log.some((l) => l === 'page:jump@7 {"arm":false}')).toBe(true);
  });

  it("turning a page-pointer tool on turns the others off (mutual exclusion, real gate)", async () => {
    const r = makeRig();
    grantAndOpen(r.client, 7);
    r.bus.firePageEvent({ kind: "aiuiSupport", tab: 7, supported: true });
    r.client.dispatch("pencil");
    expect(r.client.state().pencil).toBe(true);
    r.client.dispatch("jump"); // needs __AIUI__ (fired above) + the open turn
    expect(r.client.state().jump).toBe(true);
    expect(r.client.state().pencil).toBe(false); // pencil yielded — one tool at a time
  });
});

describe("the wire engine is DRIVEN — one machine, no dual truth", () => {
  it("activation opens a real thread; the hello meta carries tab + actor + config", async () => {
    const r = makeRig();
    grantAndOpen(r.client, 7);
    expect(r.lanes.engine.threadOpen).toBe(true); // the wire engine followed
    r.client.dispatch("pencil"); // a contentful event so the wire dials
    await settle(30);
    expect(r.thread.dials.length).toBeGreaterThan(0);
    const meta = r.thread.dials[0];
    expect(meta.actor).toBe("human");
    expect((meta.tab as { url: string }).url).toBe("http://page.example/");
    // stt/linter reached the engine's declared config (read at construction)
    expect((meta.intent as { transcriber: string }).transcriber).toBe("elevenlabs"); // scribe-v2 default
    // the CDP-alignment snapshot rides the hello (the prelude renders it)
    expect(meta.cdp).toEqual({
      state: "aligned",
      boundPort: 55555,
      coDrivers: [{ port: 60001, label: "other :60001" }],
    });
  });

  it("send with content lowers and closes; the seat stays armed", async () => {
    const r = makeRig();
    grantAndOpen(r.client, 7);
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
    grantAndOpen(r.client, 7);
    r.client.dispatch("send");
    await settle();
    expect(r.client.state().phase).toBe("armed");
    expect(r.lanes.engine.threadOpen).toBe(false); // stepOut — reason "cancel"
  });

  it("the wire closing the thread flows BACK: engine timeout → mode engine armed", async () => {
    const r = makeRig();
    grantAndOpen(r.client, 7);
    expect(r.client.state().phase).toBe("turn");
    // The server/timeout side: the wire engine closes its thread itself.
    r.lanes.engine.stepOut();
    await settle();
    expect(r.client.state().phase).toBe("armed"); // turnClosed binding fired
  });

  it("a lowered-prompt push narrates to the status line (the echo pane is gone); channel errors reach the toast line", async () => {
    const r = makeRig();
    grantAndOpen(r.client, 7);
    r.client.dispatch("pencil");
    await settle(30);
    r.thread.serverPush?.({ kind: "lowered-prompt", prompt: "LOWERED" });
    r.thread.serverPush?.({ kind: "error", message: "no such model", source: "channel" });
    // The prompt itself is not resurfaced — the trace viewer owns it; the
    // status line just confirms the round trip.
    expect(r.statuses).toContain("turn sent — lowered prompt received (🔍 traces)");
    expect(r.toasts).toContain("channel: no such model");
  });
});

describe("shots and selections ride the wire", () => {
  it("a manual shot grabs, flashes (shotFlash gate), and uploads the attachment", async () => {
    const r = makeRig();
    grantAndOpen(r.client, 7);
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
      grantAndOpen(r.client, 7);
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
      grantAndOpen(r.client, 7);
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
    grantAndOpen(r.client, 7);
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
    grantAndOpen(r.client, 7);
    r.bus.firePageEvent({
      kind: "navigation",
      tab: 7,
      from: "fake://tab/7/a",
      to: "fake://tab/7/b",
      navKind: "push",
      tabRecord: { url: "fake://tab/7/b", title: "b", aiui: true },
    });
    const nav = r.lanes.engine.events.find((e) => e.type === "navigation") as
      | { from: string; to: string; kind?: string; tab?: unknown }
      | undefined;
    expect(nav).toMatchObject({ from: "fake://tab/7/a", to: "fake://tab/7/b", kind: "push" });
    // The destination's canonical tab record rides the event untouched.
    expect(nav?.tab).toEqual({ url: "fake://tab/7/b", title: "b", aiui: true });
  });

  it("a tab SWITCH mid-turn is its OWN event (tab-switch), not a navigation, naming both sides and both tabs", async () => {
    const r = makeRig();
    r.bus.setTabUrl(7, "fake://tab/7/docs");
    r.bus.setTabUrl(9, "fake://tab/9/app");
    grantAndOpen(r.client, 7);
    await settle(); // seed lastActiveTab
    r.bus.switchTab(9);
    await settle(20);
    // A tab switch is a distinct boundary — no `navigation` event is minted.
    expect(r.lanes.engine.events.some((e) => e.type === "navigation")).toBe(false);
    const sw = r.lanes.engine.events.find((e) => e.type === "tab-switch") as
      | { from: string; to: string; fromTab?: number; toTab?: number; tab?: unknown }
      | undefined;
    expect(sw).toMatchObject({
      from: "fake://tab/7/docs",
      to: "fake://tab/9/app",
      fromTab: 7,
      toTab: 9,
    });
    // The destination's record is assembled from whatever tabInfo contributed.
    expect(sw?.tab).toEqual({ url: "fake://tab/9/app" });
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

describe("pause — the bracket, the suppression, and the resume compare (owner, 2026-07-30)", () => {
  const types = (r: Rig): string[] => r.lanes.engine.events.map((e) => e.type);

  it("pause/resume bracket the stream, reason-free, and ride the wire like any event", async () => {
    const r = makeRig();
    grantAndOpen(r.client, 7);
    r.client.dispatch("pause");
    r.client.dispatch("pause");
    await settle();
    expect(types(r)).toContain("turn-pause");
    expect(types(r)).toContain("turn-resume");
    const pause = r.lanes.engine.events.find((e) => e.type === "turn-pause");
    expect(Object.keys(pause ?? {}).sort()).toEqual(["at", "type"]); // no reason field — ever
  });

  it("an unchanged tab across the pause emits NO boundary (the whole point of the compare)", async () => {
    const r = makeRig();
    r.bus.setTabUrl(7, "fake://tab/7/docs");
    grantAndOpen(r.client, 7);
    await settle();
    r.client.dispatch("pause");
    await settle();
    r.client.dispatch("pause"); // resume, having gone nowhere
    await settle(20);
    expect(types(r)).not.toContain("tab-switch");
    expect(types(r)).not.toContain("navigation");
  });

  it("mid-pause tab switches are suppressed; resume emits ONE tab-switch, after the turn-resume", async () => {
    const r = makeRig();
    r.bus.setTabUrl(7, "fake://tab/7/docs");
    r.bus.setTabUrl(8, "fake://tab/8/detour");
    r.bus.setTabUrl(9, "fake://tab/9/app");
    grantAndOpen(r.client, 7);
    await settle();
    r.client.dispatch("pause");
    await settle();
    r.bus.switchTab(8); // the wander — nobody's business
    await settle(20);
    r.bus.switchTab(9);
    await settle(20);
    expect(types(r)).not.toContain("tab-switch"); // suppressed while paused

    r.client.dispatch("pause"); // resume on tab 9
    await settle(20);
    const switches = r.lanes.engine.events.filter((e) => e.type === "tab-switch");
    expect(switches).toHaveLength(1); // ONE boundary for the whole gap
    expect(switches[0]).toMatchObject({
      from: "fake://tab/7/docs",
      to: "fake://tab/9/app",
      fromTab: 7,
      toTab: 9,
    });
    const t = types(r);
    expect(t.indexOf("turn-resume")).toBeLessThan(t.indexOf("tab-switch"));
  });

  it("the same tab on a DIFFERENT url resumes to ONE navigation, kind unknown", async () => {
    const r = makeRig();
    r.bus.setTabUrl(7, "fake://tab/7/before");
    grantAndOpen(r.client, 7);
    await settle();
    r.client.dispatch("pause");
    await settle();
    r.bus.setTabUrl(7, "fake://tab/7/after");
    r.bus.firePageEvent({
      kind: "navigation",
      tab: 7,
      from: "fake://tab/7/before",
      to: "fake://tab/7/after",
      navKind: "push",
    });
    await settle();
    expect(types(r)).not.toContain("navigation"); // suppressed while paused

    r.client.dispatch("pause"); // resume
    await settle(20);
    const navs = r.lanes.engine.events.filter((e) => e.type === "navigation") as Array<{
      from: string;
      to: string;
      kind?: string;
    }>;
    expect(navs).toHaveLength(1);
    expect(navs[0]).toMatchObject({ from: "fake://tab/7/before", to: "fake://tab/7/after" });
    expect(navs[0].kind).toBeUndefined(); // we deliberately were not watching how
  });

  it("a cancel while paused closes with the bracket unmatched — no resume rides a dying thread", async () => {
    const r = makeRig();
    grantAndOpen(r.client, 7);
    r.client.dispatch("pause");
    r.client.dispatch("cancelTurn");
    await settle(20);
    const t = types(r);
    expect(t).toContain("turn-pause");
    expect(t).not.toContain("turn-resume");
    expect(t.filter((x) => x === "thread-close")).toHaveLength(1);
    // …and the next turn opens with a clean gate: a mid-turn switch records.
    r.bus.setTabUrl(9, "fake://tab/9/next");
    r.client.dispatch("turn");
    await settle();
    r.bus.switchTab(9);
    await settle(20);
    expect(r.lanes.engine.events.filter((e) => e.type === "tab-switch")).toHaveLength(1);
  });
});

describe("the oracle session's credential and its ending (O3a, owner 2026-07-30)", () => {
  /** A transport with no peer: it records what was sent and hands back the
   * `onClose` hook, so a test can end a session the way the vendor's ~60-minute
   * cap does — from the outside, with nobody asking. */
  const fakeTransport = () => {
    const seam: {
      close?: (reason: string) => void;
      micEnabled: boolean;
      connects: number;
      sent: Array<Record<string, unknown>>;
    } = { micEnabled: true, connects: 0, sent: [] };
    const transport = {
      name: "fake",
      capabilities: {
        replyAudioData: false,
        serverBargeIn: true,
        injectAudio: false,
        sideband: false,
      },
      connect: (options: { onClose: (reason: string) => void }) => {
        seam.connects += 1;
        seam.close = options.onClose;
        // A fresh connect means a fresh track, and a `getUserMedia` track comes
        // up ENABLED (webrtc.ts) — so a reconnect must not inherit the last
        // session's gate. Modelling this is what makes "opened while parked"
        // testable instead of an artifact of a sticky fake.
        seam.micEnabled = true;
        return Promise.resolve({
          send: (event: Record<string, unknown>) => seam.sent.push(event),
          setMicEnabled: (on: boolean) => {
            seam.micEnabled = on;
          },
          interrupt: () => {},
          close: () => {},
        });
      },
    };
    return { transport: transport as never, seam };
  };

  /** Counts credentials handed out — one per session start, by design. */
  const countingKeySource = (issued: string[]) => ({
    describe: () => "test",
    credential: async () => {
      issued.push(`ek_${issued.length + 1}`);
      return { ek: issued[issued.length - 1] as string, expiresAt: 0 };
    },
  });

  const oracleRig = (over: Partial<ChannelLanesConfig> = {}): Rig => {
    const bus = fakeBus({ activeTab: 7 });
    const { thread, openThread } = stubThread();
    const toasts: string[] = [];
    const statuses: string[] = [];
    const lanes = createChannelLanes({
      host: bus,
      port: () => 55555,
      openThread,
      onToast: (m) => toasts.push(m),
      onStatus: (line) => statuses.push(line),
      ...over,
    });
    const client = createIntentClient({
      host: bus,
      lanes: lanes.lanes,
      claimOptions: lanes.claimOptions,
    });
    const unbind = lanes.bind(client);
    client.setContext({ connected: true, micGranted: true });
    rig = { client, bus, lanes, thread, toasts, statuses, unbind };
    return rig;
  };

  it("mints a FRESH credential per session — never reuses one across starts", async () => {
    const issued: string[] = [];
    const { transport } = fakeTransport();
    const r = oracleRig({ oracleTransport: transport, oracleKeySource: countingKeySource(issued) });

    r.client.dispatch("oracle");
    await settle(30);
    expect(issued).toHaveLength(1);

    r.client.dispatch("oracle"); // off
    await settle(20);
    r.client.dispatch("oracle"); // on again
    await settle(30);
    // A caching source would reuse the live secret; per-session minting asks
    // again — the mint is a loopback round trip, so freshness beats reuse.
    expect(issued).toHaveLength(2);
  });

  it("a connect failure reaches the CLAIM (start resolves either way — it must be translated)", async () => {
    const { transport } = fakeTransport();
    const r = oracleRig({
      oracleTransport: transport,
      oracleKeySource: {
        describe: () => "broken",
        credential: () => Promise.reject(new Error("no OPENAI_API_KEY in the channel")),
      },
    });
    r.client.dispatch("oracle");
    await settle(30);
    // OracleSession.start() RESOLVES on failure (chromeless: it records and
    // sets `error`), so a naive acquire would have reported `active` over a
    // session that never connected.
    expect(r.client.claimStatuses().oracleSession?.phase).toBe("error");
    expect(r.toasts.some((t) => t.includes("no OPENAI_API_KEY"))).toBe(true);
    // The DESIRE stands — the user asked, the world refused; the cap stays lit.
    expect(r.client.state().oracle).toBe(true);
  });

  it("a failed start can be RETRIED — the error status does not wedge the session", async () => {
    let refuse = true;
    const { transport, seam } = fakeTransport();
    const r = oracleRig({
      oracleTransport: transport,
      oracleKeySource: {
        describe: () => "flaky",
        credential: () =>
          refuse
            ? Promise.reject(new Error("mint refused"))
            : Promise.resolve({ ek: "ek_ok", expiresAt: 0 }),
      },
    });
    r.client.dispatch("oracle");
    await settle(30);
    expect(r.client.claimStatuses().oracleSession?.phase).toBe("error");

    // Press again with the world fixed. Without the defensive close in the
    // lane's `start`, the session's own guard (start no-ops unless idle|closed)
    // would swallow this — and the reconciler never releases an acquire that
    // threw, so nothing else would reset it.
    refuse = false;
    r.client.dispatch("oracle"); // off
    await settle(20);
    r.client.dispatch("oracle"); // on — the retry
    await settle(30);
    expect(r.client.claimStatuses().oracleSession?.phase).toBe("active");
    expect(seam.connects).toBe(1);
  });

  it("a session that ends UNASKED drops the desire — no lit cap over a dead session", async () => {
    const { transport, seam } = fakeTransport();
    const r = oracleRig({ oracleTransport: transport, oracleKeySource: countingKeySource([]) });
    r.client.dispatch("oracle");
    await settle(30);
    expect(r.client.state().oracle).toBe(true);

    // The vendor's ~60-minute cap, a dropped data channel — the transport says
    // it is over and nobody asked.
    seam.close?.("data channel closed");
    await settle(20);
    expect(r.client.state().oracle).toBe(false);
    expect(r.toasts.some((t) => t.includes("oracle session ended"))).toBe(true);
    expect(r.toasts.some((t) => t.includes("data channel closed"))).toBe(true);
  });

  it("a DELIBERATE close does not toast — the region is already down when it lands", async () => {
    const { transport } = fakeTransport();
    const r = oracleRig({ oracleTransport: transport, oracleKeySource: countingKeySource([]) });
    r.client.dispatch("oracle");
    await settle(30);
    r.client.dispatch("oracle"); // the user turns it off; release closes it
    await settle(30);
    expect(r.client.state().oracle).toBe(false);
    expect(r.toasts.some((t) => t.includes("oracle session ended"))).toBe(false);
  });

  it("hands the oracle the tab's tools, and re-projects them LIVE (O3b)", async () => {
    const { transport } = fakeTransport();
    const r = oracleRig({ oracleTransport: transport, oracleKeySource: countingKeySource([]) });
    // The PAGE group specifically: the panel group rides the same surface (O3c)
    // and is asserted on its own below.
    const names = () => r.lanes.oracle.state().toolNames.filter((n) => !n.startsWith("panel_"));

    // Tools registered BEFORE the session opens are there at connect — a
    // connect is not a change, so the projection has to be applied at both.
    r.bus.firePageEvent({
      kind: "pageTools",
      tab: 7,
      registrations: [{ ns: "app", tools: [{ name: "set_freq", description: "set frequency" }] }],
    });
    r.client.dispatch("oracle");
    await settle(30);
    expect(names()).toEqual(["set_freq"]);

    // The page registers another at runtime — mid-session, no reconnect.
    r.bus.firePageEvent({
      kind: "pageTools",
      tab: 7,
      registrations: [
        {
          ns: "app",
          tools: [
            { name: "set_freq", description: "set frequency" },
            { name: "kick", description: "kick the wave" },
          ],
        },
      ],
    });
    await settle(20);
    expect(names()).toEqual(["set_freq", "kick"]);

    // Looking at a tab with NO tools keeps the last app's (owner, 2026-07-30 —
    // a tool surface is ambient; it must not evaporate because you glanced at
    // a console). Switching back changes nothing, because nothing was lost.
    r.bus.switchTab(9);
    await settle(20);
    expect(names()).toEqual(["set_freq", "kick"]);
    r.bus.switchTab(7);
    await settle(20);
    expect(names()).toEqual(["set_freq", "kick"]);
  });

  it("a DIFFERENT app in view wins over the remembered one", async () => {
    const { transport } = fakeTransport();
    const r = oracleRig({ oracleTransport: transport, oracleKeySource: countingKeySource([]) });
    const names = () => r.lanes.oracle.state().toolNames.filter((n) => !n.startsWith("panel_"));
    r.bus.firePageEvent({
      kind: "pageTools",
      tab: 7,
      registrations: [{ ns: "app", tools: [{ name: "first", description: "" }] }],
    });
    r.bus.firePageEvent({
      kind: "pageTools",
      tab: 9,
      registrations: [{ ns: "app", tools: [{ name: "second", description: "" }] }],
    });
    r.client.dispatch("oracle");
    await settle(30);
    expect(names()).toEqual(["first"]);
    r.bus.switchTab(9); // the eye is on another APP — it wins
    await settle(20);
    expect(names()).toEqual(["second"]);
  });

  it("a remembered tab that LOSES its tools drops out rather than firing into nothing", async () => {
    const { transport } = fakeTransport();
    const r = oracleRig({ oracleTransport: transport, oracleKeySource: countingKeySource([]) });
    const names = () => r.lanes.oracle.state().toolNames.filter((n) => !n.startsWith("panel_"));
    r.bus.firePageEvent({
      kind: "pageTools",
      tab: 7,
      registrations: [{ ns: "app", tools: [{ name: "kick", description: "" }] }],
    });
    r.client.dispatch("oracle");
    await settle(30);
    r.bus.switchTab(9); // remembered: tab 7
    await settle(20);
    expect(names()).toEqual(["kick"]);

    // The app tab closed / unloaded its tools.
    r.bus.firePageEvent({ kind: "pageTools", tab: 7, registrations: [] });
    await settle(20);
    expect(names()).toEqual([]);
  });

  it("prefixes with the namespace only when more than one registers", async () => {
    const { transport } = fakeTransport();
    const r = oracleRig({ oracleTransport: transport, oracleKeySource: countingKeySource([]) });
    r.bus.firePageEvent({
      kind: "pageTools",
      tab: 7,
      registrations: [
        { ns: "app", tools: [{ name: "kick", description: "" }] },
        { ns: "viz", tools: [{ name: "kick", description: "" }] },
      ],
    });
    r.client.dispatch("oracle");
    await settle(30);
    // Same bare name in two namespaces would collide in the vendor's flat tool
    // space; the prefix is what keeps them distinct.
    expect(r.lanes.oracle.state().toolNames.filter((n) => !n.startsWith("panel_"))).toEqual([
      "app_kick",
      "viz_kick",
    ]);
  });

  it("the toggle is the off switch — off means an EMPTY surface, not a stale one", async () => {
    const { transport } = fakeTransport();
    const r = oracleRig({ oracleTransport: transport, oracleKeySource: countingKeySource([]) });
    r.bus.firePageEvent({
      kind: "pageTools",
      tab: 7,
      registrations: [{ ns: "app", tools: [{ name: "kick", description: "" }] }],
    });
    const pageNames = () => r.lanes.oracle.state().toolNames.filter((n) => !n.startsWith("panel_"));
    r.client.dispatch("oracle");
    await settle(30);
    expect(pageNames()).toEqual(["kick"]);

    oraclePageTools.set(false);
    await settle(20);
    expect(pageNames()).toEqual([]);
    oraclePageTools.set(true);
    await settle(20);
    expect(pageNames()).toEqual(["kick"]);
  });

  it("a projected tool CALLS the page — and the tab it was built for, not the one in view", async () => {
    const { transport } = fakeTransport();
    const r = oracleRig({ oracleTransport: transport, oracleKeySource: countingKeySource([]) });
    r.bus.firePageEvent({
      kind: "pageTools",
      tab: 7,
      registrations: [{ ns: "app", tools: [{ name: "kick", description: "" }] }],
    });
    r.client.dispatch("oracle");
    await settle(30);

    // Reach the projected tool the way the session would when the model calls.
    const tool = oracleToolsForTab(r.lanes.pageTools, 7).find((t) => t.name === "kick");
    expect(tool).toBeDefined();
    const answer = tool?.execute({ force: 3 });
    await settle();
    const line = r.bus.log.filter((l) => l.includes("toolsCall")).at(-1) ?? "";
    expect(line).toContain("@7"); // the tab the projection named
    const callId = (JSON.parse(line.slice(line.indexOf("{"))) as { callId: string }).callId;
    r.bus.firePageEvent({ kind: "toolsResult", tab: 7, callId, ok: true, value: { kicked: 3 } });
    await expect(answer).resolves.toEqual({ kicked: 3 });
  });

  it("shots, area drags and selections FOLLOW the sink into the oracle (O3d)", async () => {
    const { transport } = fakeTransport();
    const r = oracleRig({ oracleTransport: transport, oracleKeySource: countingKeySource([]) });
    activationGesture(r.client, 7); // a grant, so the pixel acts are live
    r.bus.firePageEvent({ kind: "selectionPresent", tab: 7, present: true });
    r.bus.answerWith("selection", { text: "42.7", sourceLoc: "src/Readout.tsx:12:4" });
    r.client.dispatch("oracle");
    await settle(30);
    const injected = () => r.lanes.oracle.ledger().filter((e) => e.kind === "injected");

    // A manual shot: attached as an IMAGE, with a caption — never a path,
    // because the pixels ride inline (there is nothing on disk to name).
    r.client.dispatch("shot");
    await settle(30);
    expect(injected().at(-1)).toMatchObject({ role: "user", image: true });
    expect((injected().at(-1) as { text?: string }).text).toContain(
      "screenshot of what I'm looking at",
    );

    // A selection: the lowered prompt's OWN rendering, verbatim.
    r.client.dispatch("selection");
    await settle(30);
    const selection = injected().at(-1) as { text?: string; image?: boolean };
    expect(selection.image).toBeUndefined();
    expect(selection.text).toContain("[selected text:");

    // …and NOTHING landed in the turn behind it.
    expect(r.lanes.engine.events.some((e) => e.type === "shot")).toBe(false);
    expect(r.lanes.engine.events.some((e) => e.type === "app-selection")).toBe(false);
  });

  it("an area drag reaches the oracle with its located elements (O3d)", async () => {
    const { transport } = fakeTransport();
    const r = oracleRig({ oracleTransport: transport, oracleKeySource: countingKeySource([]) });
    activationGesture(r.client, 7);
    r.client.dispatch("oracle");
    await settle(30);

    r.bus.firePageEvent({
      kind: "regionDrag",
      tab: 7,
      rect: { x: 10, y: 20, w: 200, h: 100 },
      viewport: { w: 1000, h: 800 },
      takenAt: Date.now(),
      components: [{ component: "LegendBox", source: "src/Legend.tsx:12:3" }],
    });
    await settle(30);

    const last = r.lanes.oracle
      .ledger()
      .filter((e) => e.kind === "injected")
      .at(-1) as {
      text?: string;
      image?: boolean;
    };
    expect(last.image).toBe(true);
    expect(last.text).toContain("area I selected");
    expect(last.text).toContain("200×100");
    // The SAME element block the lowered prompt would carry — one renderer.
    expect(last.text).toContain('<screenshot-metadata attached="true">');
    expect(last.text).toContain('name="LegendBox"');
    expect(r.lanes.engine.events.some((e) => e.type === "shot")).toBe(false);
  });

  it("with the turn as the sink they still land in the TURN — the fork is the only change", async () => {
    const r = makeRig();
    grantAndOpen(r.client, 7);
    r.bus.firePageEvent({ kind: "selectionPresent", tab: 7, present: true });
    r.client.dispatch("shot");
    await settle(30);
    expect(r.lanes.engine.events.some((e) => e.type === "shot")).toBe(true);
    expect(r.lanes.oracle.ledger().filter((e) => e.kind === "injected")).toHaveLength(0);
  });

  it("tells the session which page it is standing on (O3d prelude)", async () => {
    const { transport, seam } = fakeTransport();
    const r = oracleRig({
      oracleTransport: transport,
      oracleKeySource: countingKeySource([]),
      tabMeta: async () => ({ url: "http://localhost:5173/sim", title: "the sim" }),
    });
    r.client.dispatch("oracle");
    await settle(30);
    // Re-woven instructions carrying the SAME `<tab …/>` shape the lowered
    // prompt renders, so "this page" means one thing to both readers.
    const updates = JSON.stringify(seam.sent.filter((e) => e.type === "session.update"));
    expect(updates).toContain("localhost:5173/sim");
    expect(updates).toContain("<tab");
  });

  it("the session comes up LISTENING, and park is what stops it", async () => {
    const { transport, seam } = fakeTransport();
    const r = oracleRig({ oracleTransport: transport, oracleKeySource: countingKeySource([]) });
    r.client.dispatch("oracle");
    await settle(30);
    // Turning it on means listening (owner, 2026-07-30) — asserted on the
    // TRACK, not on the lane call that was supposed to enable it.
    expect(seam.micEnabled).toBe(true);
    r.client.dispatch("oraclePark");
    expect(seam.micEnabled).toBe(false);
    r.client.dispatch("oraclePark");
    expect(seam.micEnabled).toBe(true);
    // A turn-side grip never touches this track.
    r.client.dispatch("handsFree");
    expect(seam.micEnabled).toBe(true);
  });

  it("a session opened while PARKED comes up gated (the connect is not an edge)", async () => {
    const { transport, seam } = fakeTransport();
    const r = oracleRig({ oracleTransport: transport, oracleKeySource: countingKeySource([]) });
    r.client.dispatch("oracle");
    await settle(30);
    r.client.dispatch("oraclePark");
    expect(seam.micEnabled).toBe(false);

    // Close and reopen with park still standing… except it does not stand:
    // `park-needs-oracle` clears it with the session, so the next one comes up
    // listening. That is the rule, and this pins it rather than the accident.
    r.client.dispatch("oracle"); // off — the exclude clears oracleParked
    await settle(20);
    expect(r.client.state().oracleParked).toBe(false);
    r.client.dispatch("oracle"); // on again
    await settle(30);
    expect(seam.micEnabled).toBe(true);
  });
});

describe("the pencilSurface claim (mode-gated, tab-following)", () => {
  it("engages only when markup is ON, re-relays fade live, re-points on tab switch, releases on disarm", async () => {
    const r = makeRig();
    grantAndOpen(r.client, 7); // grant + arm + turn on tab 7
    await settle(30);
    // Pencil mode is OFF by default (ink's twin — not auto-on), so nothing engages.
    expect(r.bus.log.some((l) => l.startsWith("page:pencil@"))).toBe(false);

    r.client.dispatch("pencil"); // markup ON → the claim engages the tab in view
    await settle(30);
    expect(r.bus.log).toContain('page:pencil@7 {"op":"engage","fadeSec":0}');
    r.bus.clearLog();

    // Vanishing on + a fade move → a LIVE fade re-relay (claim active, same tab).
    const { pencilVanish, pencilFade } = await import("./config");
    pencilVanish.set(true as never);
    pencilFade.set(9 as never);
    await settle(30);
    expect(r.bus.log).toContain('page:pencil@7 {"op":"fade","fadeSec":9}');
    r.bus.clearLog();

    // A tab switch RE-POINTS the claim: release the old tab, acquire the new.
    r.bus.switchTab(9);
    await settle(30);
    expect(r.bus.log).toContain('page:pencil@7 {"op":"disengage"}');
    expect(r.bus.log.some((l) => l.startsWith('page:pencil@9 {"op":"engage"'))).toBe(true);
    r.bus.clearLog();

    // Disarm clears pencil mode AND leaves the turn → the claim releases.
    r.client.dispatch("disarm");
    await settle(30);
    expect(r.bus.log).toContain('page:pencil@9 {"op":"disengage"}');
    // …and SWEEPS the strokes on EVERY tab engaged this session (owner,
    // 2026-07-17): tab 7 kept its markup through the switch-away (the claim
    // only disengages); disarm is the actual end, so both tabs get a clear.
    expect(r.bus.log).toContain('page:pencil@7 {"op":"clear"}');
    expect(r.bus.log).toContain('page:pencil@9 {"op":"clear"}');
    pencilVanish.set(false as never);
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
    grantAndOpen(client1, 7);
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

  it("a reload during a PAUSE recovers collecting — the dangling bracket is closed at recovery", async () => {
    let saved: { events: never[]; threadOpen: boolean } | undefined;
    const mirror = {
      persist: (events: never[], threadOpen: boolean) => {
        saved = threadOpen && events.length > 0 ? { events, threadOpen } : undefined;
      },
      recover: () => saved,
    };

    // Page 1: a content-ful turn, paused, then the page dies.
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
    grantAndOpen(client1, 7);
    lanes1.engine.contribute("paused mid-thought");
    client1.dispatch("pause");
    await settle(20);
    await client1.dispose();

    // Page 2: recovery resumes collecting (paused is not durable) and closes
    // the bracket the reload interrupted.
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
    client2.setContext({ connected: true });
    expect(lanes2.recover(client2)).toBe(true);
    await settle(30);

    expect(client2.state()).toMatchObject({ phase: "turn", paused: false });
    expect(lanes2.engine.paused).toBe(false);
    const t = lanes2.engine.events.map((e) => e.type);
    // The recovered stream carries the old pause AND its recovery-minted close.
    expect(t.indexOf("turn-pause")).toBeGreaterThanOrEqual(0);
    expect(t.indexOf("turn-resume")).toBeGreaterThan(t.indexOf("turn-pause"));

    unbind2();
    await client2.dispose();
    rig = undefined;
  });

  it("no mirrored turn (or a closed one) recovers nothing", () => {
    const r = makeRig(); // makeRig's lanes use the DEFAULT sessionStorage mirror
    sessionStorage.removeItem("aiui2.turn");
    expect(r.lanes.recover(r.client)).toBe(false);
    // Armed (the connect edge, not recover — recover moved nothing) and no turn.
    expect(r.client.state().phase).toBe("armed");
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
    grantAndOpen(r.client, 7);
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
      grantAndOpen(r.client, 7);
      r.client.dispatch("pencil");
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
      grantAndOpen(r.client, 7); // opens a turn → thread-open → socket dialed
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

describe("the converse (debug) lint button — the control rail + auto-off", () => {
  it("lintNow rides the open thread as a `lint` control chunk", async () => {
    const r = makeRig();
    try {
      linter.set("openai");
      grantAndOpen(r.client, 7);
      await settle(30);
      const before = r.thread.chunks.length;
      r.lanes.lintNow();
      await settle(30);
      const controls = r.thread.chunks.slice(before).filter((c) => c.kind === "chunk:control");
      expect(controls.map((c) => c.payload)).toEqual([{ control: "lint", value: "now" }]);
      expect(controls.every((c) => c.fin === false)).toBe(true); // never fins the thread
    } finally {
      linter.set("off");
    }
  });

  it("a pushed linter-turn-complete leaves the select alone — STAY-ON (the select is the only off switch)", async () => {
    const r = makeRig();
    try {
      linter.set("openai");
      grantAndOpen(r.client, 7);
      r.client.dispatch("pencil"); // contentful → the wire dials (serverPush exists)
      await settle(30);
      const before = r.thread.chunks.length;
      r.thread.serverPush?.({
        kind: "lowered",
        events: [{ at: Date.now(), type: "linter-turn-complete", segment: 1 }],
      });
      await settle(30);
      // No auto-off (overhear retirement, 2026-07-19): the linter stays on…
      expect(linter.get()).toBe("openai");
      // …so no control chunk goes out either — nothing changed to relay.
      expect(r.thread.chunks.slice(before).some((c) => c.kind === "chunk:control")).toBe(false);
      // The event still reached the chronicle (the pulse settles off it).
      expect(r.lanes.engine.events.some((event) => event.type === "linter-turn-complete")).toBe(
        true,
      );
    } finally {
      linter.set("off");
    }
  });
});
