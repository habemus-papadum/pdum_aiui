// @vitest-environment jsdom
/**
 * client.test.ts — the harness: the whole client driven through dispatch()
 * and the FakeBus, asserting transport effects and projections. The rows are
 * the bug ledger (parity inventory §3) re-expressed as passing tests — each
 * `// ledger:` comment names the incident the row would have caught.
 */
import { controlByName, disposeDurable } from "@habemus-papadum/aiui-viz";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activationGesture } from "./activation";
import { createIntentClient, type IntentClient, type IntentLanes } from "./client";
import { type FakeBus, fakeBus } from "./fake-bus";
import { intentSpec } from "./spec";
import { type RingState, ringForTab } from "./transport";

const settle = async (rounds = 12): Promise<void> => {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
};

function fakeLanes(log: string[]): IntentLanes {
  const entry =
    (name: string) =>
    (...args: unknown[]) => {
      log.push(args.length > 0 ? `${name}:${args.join(",")}` : name);
    };
  return {
    openTurn: entry("openTurn"),
    sendTurn: entry("sendTurn"),
    cancelTurn: entry("cancelTurn"),
    takeShot: entry("takeShot"),
    armRegion: entry("armRegion"),
    addSelection: entry("addSelection"),
    clearInk: entry("clearInk"),
    startTalk: entry("startTalk"),
    stopTalk: entry("stopTalk"),
    setMicMuted: entry("setMicMuted"),
  };
}

interface Rig {
  client: IntentClient;
  bus: FakeBus;
  lanes: string[];
  blips: string[];
}

let rig: Rig | undefined;

function makeRig(options: { grantless?: boolean; grantHint?: string } = {}): Rig {
  const bus = fakeBus({ activeTab: 7, grantless: options.grantless, grantHint: options.grantHint });
  const lanes: string[] = [];
  const blips: string[] = [];
  const client = createIntentClient({
    host: bus,
    lanes: fakeLanes(lanes),
    onBlip: (key) => blips.push(key),
  });
  rig = { client, bus, lanes, blips };
  return rig;
}

/** The activation shortcut with the grant minted (the SW gate, faked). */
function grantAndOpen(r: Rig, tab = 7): void {
  r.client.setContext({ connected: true });
  activationGesture(r.client, tab);
}

/** All bar items, flattened across depth rows. */
const flatBar = (r: Rig) => r.client.bar().flatMap((row) => row.items);
const findCap = (r: Rig, command: string) =>
  flatBar(r).find((item) => item.kind === "cap" && item.command === command) as
    | Extract<ReturnType<typeof flatBar>[number], { kind: "cap" }>
    | undefined;

afterEach(async () => {
  await rig?.client.dispose();
  rig = undefined;
  // Hard-reset the durable registry so each test's engine starts factory-
  // fresh: agent controls persist under control:<agent>, plain durable
  // regions under mode:<region>. (Registration replace-by-name handles the
  // control registry itself on the next makeRig.)
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

describe("the activation gesture — imperative boundary, idempotent grant-and-open", () => {
  it("opens from disarmed, is a no-op in an open turn, resumes from tweak", async () => {
    const r = makeRig();
    grantAndOpen(r);
    expect(r.client.state().phase).toBe("turn"); // armed AND opened, one gesture
    expect(r.lanes).toEqual(["openTurn"]);

    grantAndOpen(r); // ledger: "⌘B-as-escape silently abandoned turns"
    expect(r.client.state().phase).toBe("turn");
    expect(r.lanes).toEqual(["openTurn"]); // no second open, no cancel

    r.client.dispatch("tweak");
    grantAndOpen(r);
    expect(r.client.state().phase).toBe("turn"); // resumed, same turn
    expect(r.lanes).toEqual(["openTurn"]);
  });

  it("respects the arm gate: no channel, no arming — the gesture fizzles safely", () => {
    const r = makeRig(); // never connected
    activationGesture(r.client, 7);
    expect(r.client.state().phase).toBe("disarmed");
    expect(r.lanes).toEqual([]);
  });
});

describe("the capture grant is the HOST's business, not a ritual", () => {
  it("a grantless host lights the capture acts however you armed (found live: the bar left them dark)", async () => {
    // The CDP tier's screenshots ask nobody, so there is no grant to acquire —
    // and arming from the BAR (arm → turn), which mints nothing, must work
    // exactly like the ⌘B gesture. It did not: shot/selection/clear stayed
    // disabled forever, and only ink (which follows the tab in view) worked.
    const r = makeRig({ grantless: true });
    r.client.setContext({ connected: true });
    r.client.dispatch("arm");
    r.client.dispatch("turn");
    await settle();

    expect(r.client.state().phase).toBe("turn");
    expect(r.client.context().grantedTab).toBe(7);
    expect(r.client.canDispatch("shot")).toBe(true);
    r.bus.firePageEvent({ kind: "selectionPresent", tab: 7, present: true });
    expect(r.client.canDispatch("selection")).toBe(true);

    // …and the grant follows the tab you look at (BEHAVIOR: in this tier shots
    // are not pinned to the surface you granted).
    r.bus.switchTab(9);
    await settle();
    expect(r.client.context().grantedTab).toBe(9);
    r.client.dispatch("shot");
    expect(r.lanes).toContain("takeShot:9");
  });

  it("a granted host (MV3 tabCapture) still needs the gesture — the PIXEL acts stay dark until it runs", async () => {
    const r = makeRig(); // grantless: false — the invocation-gated tier
    r.client.setContext({ connected: true });
    r.client.dispatch("arm");
    r.client.dispatch("turn");
    await settle();

    expect(r.client.state().phase).toBe("turn");
    expect(r.client.context().grantedTab).toBeUndefined();
    expect(r.client.canDispatch("shot")).toBe(false);
    // …but the PAGE acts never gated on it (the split, owner 2026-07-14):
    // selection rides the content script, which follows the tab in view —
    // gated only on a selection actually EXISTING (owner, same day).
    expect(r.client.canDispatch("selection")).toBe(false);
    r.bus.firePageEvent({ kind: "selectionPresent", tab: 7, present: true });
    expect(r.client.canDispatch("selection")).toBe(true);

    activationGesture(r.client, 7); // the gesture mints the grant
    await settle();
    expect(r.client.canDispatch("shot")).toBe(true);
  });

  it("a tab switch under MV3 darkens CAPTURE only — page acts follow the tab in view", async () => {
    // The friction this fixes (owner, 2026-07-14): switching tabs used to dark
    // the whole act set until ⌘B. The doctrine now: the page transport follows
    // the tab in view; only pixels follow the grant.
    const r = makeRig();
    grantAndOpen(r); // grant minted on tab 7
    r.client.dispatch("ink");
    await settle();
    r.bus.clearLog();

    r.bus.switchTab(9); // an UNGRANTED tab
    await settle();

    expect(r.client.canDispatch("shot")).toBe(false); // pixels: dark until ⌘B here
    r.bus.firePageEvent({ kind: "selectionPresent", tab: 9, present: true });
    expect(r.client.canDispatch("selection")).toBe(true); // page act: follows the view
    expect(r.client.canDispatch("clear")).toBe(true);
    // The ink surface re-pointed at the tab in view, no grant asked.
    expect(r.bus.log.some((line) => line.startsWith("page:ink@9"))).toBe(true);
    r.client.dispatch("selection");
    expect(r.lanes).toContain("addSelection:9");
  });
});

describe("coexistence with the frozen client (never both armed)", () => {
  it("refuses to arm a tab the old client holds, and arms once it lets go", async () => {
    // The two clients share a DOM but no messaging (runtime messages never
    // cross extension ids), so they see each other exactly one way: the old
    // one's on-page ring wears an `armed` class. Two rings and two ink surfaces
    // on one page is nonsense — so the new client stands down.
    const r = makeRig();
    r.client.setContext({ connected: true });
    r.bus.firePageEvent({ kind: "foreignClient", tab: 7, armed: true });
    await settle();

    expect(r.client.context().foreignArmed).toBe(true);
    expect(r.client.canDispatch("arm")).toBe(false);
    r.client.dispatch("arm");
    expect(r.client.state().phase).toBe("disarmed");

    r.bus.firePageEvent({ kind: "foreignClient", tab: 7, armed: false });
    await settle();
    expect(r.client.canDispatch("arm")).toBe(true);
    r.client.dispatch("arm");
    expect(r.client.state().phase).toBe("armed");
  });

  it("never blocks the way OUT — disarming is always available", async () => {
    const r = makeRig();
    r.client.setContext({ connected: true });
    r.client.dispatch("arm");
    await settle();

    // The old client arms the tab underneath us (a race we cannot prevent).
    // The gate must not trap us armed: stepping down is always allowed.
    r.bus.firePageEvent({ kind: "foreignClient", tab: 7, armed: true });
    await settle();
    expect(r.client.canDispatch("arm")).toBe(true);
    r.client.dispatch("arm");
    expect(r.client.state().phase).toBe("disarmed");
  });
});

describe("the ring — a claim, committed with the dispatch", () => {
  it("is asserted in the same breath as the phase change", async () => {
    const r = makeRig();
    grantAndOpen(r);
    await settle();
    // ledger: "ring one state behind" (F1) — the desire derives from the
    // committed state, so the broadcast the bus saw is the CURRENT phase.
    // A GATED host's desire also names the granted tab + how to mint one.
    expect(r.bus.lastRing).toEqual({
      on: true,
      turnTone: true,
      grant: { tab: 7, hint: "activate" },
    });

    r.client.dispatch("disarm");
    await settle();
    expect(r.bus.lastRing).toEqual({ on: false, turnTone: false });
    // ledger: "disarm stomped back to armed" — nothing re-arms after disarm.
    expect(r.client.state().phase).toBe("disarmed");
  });

  it("walks all FOUR ring states: off → steady → breathing, hollow where the grant isn't", async () => {
    const r = makeRig({ grantHint: "⌘B" }); // gated, with a live-discovered hint
    await settle();
    expect(r.bus.lastRing).toEqual({ on: false, turnTone: false }); // off (boot broadcast)

    r.client.setContext({ connected: true });
    r.client.dispatch("arm"); // armed, NOTHING granted yet (armed from the bar)
    await settle();
    // The desire says so: a grant block with no tab — so EVERY page projects
    // hollow, each telling the user how to mint the grant right there.
    expect(r.bus.lastRing).toEqual({ on: true, turnTone: false, grant: { hint: "⌘B" } });
    expect(ringForTab(r.bus.lastRing as RingState, 7)).toEqual({
      on: true,
      turnTone: false,
      hollow: true,
      hint: "⌘B",
    });

    r.client.setContext({ grantedTab: 7 });
    r.client.dispatch("turn");
    await settle();
    expect(r.bus.lastRing).toEqual({
      on: true,
      turnTone: true,
      grant: { tab: 7, hint: "⌘B" },
    }); // breathing
    // The per-tab projection: solid on the granted tab, hollow anywhere else —
    // this is how a tab SWITCH surfaces "press ⌘B here" with no toast needed.
    expect(ringForTab(r.bus.lastRing as RingState, 7)).toEqual({ on: true, turnTone: true });
    expect(ringForTab(r.bus.lastRing as RingState, 9)).toEqual({
      on: true,
      turnTone: true,
      hollow: true,
      hint: "⌘B",
    });

    r.client.dispatch("escape"); // back to steady
    await settle();
    expect(r.bus.lastRing).toEqual({
      on: true,
      turnTone: false,
      grant: { tab: 7, hint: "⌘B" },
    });
  });

  it("a GRANTLESS host's ring never carries a grant block — there is nothing to hint at", async () => {
    const r = makeRig({ grantless: true });
    r.client.setContext({ connected: true });
    r.client.dispatch("arm");
    r.client.dispatch("turn");
    await settle();
    // CDP shots ask nobody: no grant fact, no hollow state, no hint — the
    // projection is the identity on every tab.
    expect(r.bus.lastRing).toEqual({ on: true, turnTone: true });
    expect(ringForTab(r.bus.lastRing as RingState, 9)).toEqual({ on: true, turnTone: true });
  });
});

describe("the instrumented-page fact (jump/locate anticipation)", () => {
  it("an aiuiSupport ping moves the context fact, never the modes", async () => {
    const r = makeRig();
    grantAndOpen(r);
    const before = r.client.state();
    r.bus.firePageEvent({ kind: "aiuiSupport", tab: 7, supported: true });
    expect(r.client.context().aiuiPage).toBe(true);
    expect(r.client.state()).toBe(before); // a fact, not a mode
    r.bus.firePageEvent({ kind: "aiuiSupport", tab: 7, supported: false });
    expect(r.client.context().aiuiPage).toBe(false);
  });
});

describe("send vs cancel vs disarm", () => {
  it("send keeps you armed and commits the turn (divergence 2, decided)", () => {
    const r = makeRig();
    grantAndOpen(r);
    r.client.dispatch("send");
    expect(r.client.state().phase).toBe("armed"); // ledger: "send-as-cancel"
    expect(r.lanes).toEqual(["openTurn", "sendTurn"]);
  });

  it("esc steps out one level and cancels only the turn scope", () => {
    const r = makeRig();
    grantAndOpen(r);
    r.client.dispatch("help");
    r.client.dispatch("escape"); // help dies first — not the turn
    expect(r.client.state()).toMatchObject({ help: false, phase: "turn" });
    expect(r.lanes).toEqual(["openTurn"]);

    r.client.dispatch("escape"); // now the turn cancels, seat stays armed
    expect(r.client.state().phase).toBe("armed");
    expect(r.lanes).toEqual(["openTurn", "cancelTurn"]);

    r.client.dispatch("ink"); // standing setting, to prove the hard clear
    r.client.dispatch("escape"); // the last rung: step out of armed = disarm
    expect(r.client.state()).toMatchObject({ phase: "disarmed", ink: false });

    const before = r.client.state();
    r.client.dispatch("escape"); // quiescent: nothing left to step out of
    expect(r.client.state()).toBe(before);
  });

  it("disarm abandons everything: turn cancelled, ink off, pointer released", async () => {
    const r = makeRig();
    grantAndOpen(r);
    r.client.dispatch("ink");
    await settle();
    expect(r.bus.log).toContain('page:ink@7 {"on":true,"fadeSec":0}');

    r.client.dispatch("disarm");
    await settle();
    expect(r.lanes).toContain("cancelTurn");
    expect(r.client.state()).toMatchObject({ phase: "disarmed", ink: false });
    expect(r.bus.log).toContain('page:ink@7 {"on":false}'); // claim released
    expect(r.bus.heldStreams()).toEqual([]); // warm stream let go
  });
});

describe("claims — the end of hand-called syncs", () => {
  it("ink mid-turn asserts the pointer with no sync call anywhere", async () => {
    const r = makeRig();
    grantAndOpen(r);
    await settle();
    r.bus.clearLog();
    r.client.dispatch("ink"); // ledger (F2): "caps stale after selection change",
    await settle(); //            "command bar completely missing" — the class
    expect(r.bus.log).toContain('page:ink@7 {"on":true,"fadeSec":0}');
  });

  it("the warm stream is held for the turn's life and re-pointed on re-grant", async () => {
    const r = makeRig();
    grantAndOpen(r);
    await settle();
    expect(r.bus.heldStreams()).toEqual([7]);

    r.client.dispatch("send");
    await settle();
    expect(r.bus.heldStreams()).toEqual([]); // released with the turn
  });

  it("key routing follows the ACTIVE tab and leaves tweak alone", async () => {
    const r = makeRig();
    grantAndOpen(r);
    await settle();
    expect(r.bus.log).toContain('page:keylayer@7 {"capture":true}');

    r.bus.switchTab(9); // ledger: tab switch re-points capture
    await settle();
    expect(r.bus.log).toContain('page:keylayer@7 {"capture":false}');
    expect(r.bus.log).toContain('page:keylayer@9 {"capture":true}');

    r.client.dispatch("tweak"); // ledger: "ink kept drawing in tweak" — in
    await settle(); //             tweak the page owns keys; capture released
    expect(r.bus.log).toContain('page:keylayer@9 {"capture":false}');
  });

  it("video sampling requires turn ∧ video ∧ grant — and reports status", async () => {
    const r = makeRig();
    r.client.dispatch("video"); // standing setting, no turn: nothing samples
    await settle();
    expect(r.bus.log.filter((l) => l.includes("viewport"))).toEqual([]);

    grantAndOpen(r);
    await settle();
    expect(r.bus.log).toContain('page:viewport@7 {"sample":true,"mode":"smart"}');
    expect(r.client.claimStatuses().videoSample?.phase).toBe("active");

    r.client.dispatch("fpsMode"); // cadence flip re-asserts the operation
    await settle();
    expect(r.bus.log).toContain('page:viewport@7 {"sample":true,"mode":"constant"}');
  });

  it("a failing applier parks in error with the reason — visible, not silent", async () => {
    const r = makeRig();
    r.bus.failCapability("ink", "surface refused");
    const errors: unknown[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args);
    });
    grantAndOpen(r);
    r.client.dispatch("ink");
    await settle();
    expect(r.client.claimStatuses().inkPointer?.phase).toBe("error");
  });
});

describe("the agent bridge — one writer, no mirrors", () => {
  it("an agent's set videoOn starts sampling mid-turn (the liveSignal desync, fixed by construction)", async () => {
    const r = makeRig();
    grantAndOpen(r);
    await settle();
    r.bus.clearLog();

    // ledger: "agent set videoOn true moved the control and never the
    // mirror — sampling never started, permanently" (write-semantics §4.2).
    controlByName("videoOn")?.set(true as never);
    await settle();
    expect(r.client.state().video).toBe(true);
    expect(r.bus.log).toContain('page:viewport@7 {"sample":true,"mode":"smart"}');

    // And the cap agrees, same tick — ledger: "video cap showed the
    // OPPOSITE state" (F1 cap inversion).
    expect(findCap(r, "video")?.lit).toBe(true);
  });
});

describe("talk — per-turn, hold vs hands-free", () => {
  it("space holds, space-up releases; h toggles; mute only while talking", () => {
    const r = makeRig();
    grantAndOpen(r);
    r.client.handleKey(" ", "down", false);
    expect(r.client.state().talk).toBe("hold");
    expect(r.lanes).toContain("startTalk:hold");

    r.client.handleKey(" ", "down", true); // held-key repeats are swallowed
    expect(r.lanes.filter((l) => l === "startTalk:hold")).toHaveLength(1);
    // ledger: "held-Space repeats scrolled the page" — the swallow verdict

    r.client.handleKey("m", "down", false);
    expect(r.client.state().micMuted).toBe(true);
    expect(r.lanes).toContain("setMicMuted:true");

    r.client.handleKey(" ", "up", false);
    expect(r.client.state().talk).toBe("off");
    expect(r.lanes).toContain("stopTalk");
    expect(r.client.state().micMuted).toBe(false); // mute needs talk
  });

  it("every exit from the turn ends the talk window (the exclude, not memory)", () => {
    const r = makeRig();
    grantAndOpen(r);
    r.client.dispatch("handsFree");
    expect(r.client.state().talk).toBe("handsFree");

    r.client.dispatch("send"); // ledger: "stuck `talking` outlived its thread"
    expect(r.client.state().talk).toBe("off");
    expect(r.lanes).toContain("stopTalk");
  });
});

describe("keys — the grammar is the machine's only keyboard", () => {
  it("unknown in-turn keys swallow + blip; nothing leaks, nothing exits", () => {
    const r = makeRig();
    grantAndOpen(r);
    const before = r.client.state();
    r.client.handleKey("q", "down", false);
    expect(r.client.state()).toBe(before); // ledger: key blip (F1) — state untouched
    expect(r.blips).toEqual(["q"]);
    r.client.handleKey("Shift", "down", false); // modifiers never blip
    expect(r.blips).toEqual(["q"]);
  });

  it("outside a turn every key passes to the page", () => {
    const r = makeRig();
    r.client.handleKey("i", "down", false);
    expect(r.client.state().ink).toBe(false); // not in turn: the page keeps `i`
    expect(r.blips).toEqual([]);
  });

  it("forwarded page keys take the identical path", () => {
    const r = makeRig();
    grantAndOpen(r);
    r.bus.firePageEvent({ kind: "keyForward", tab: 7, key: "i", phase: "down", repeat: false });
    expect(r.client.state().ink).toBe(true);
  });
});

describe("system events", () => {
  it("the wire closing the thread returns the seat to armed", () => {
    const r = makeRig();
    grantAndOpen(r);
    r.client.emit("turnClosed"); // ledger: idle-timeout / server-side close
    expect(r.client.state().phase).toBe("armed");
  });

  it("window blur kills transients and nothing else", () => {
    const r = makeRig();
    grantAndOpen(r);
    r.client.dispatch("ink");
    r.client.dispatch("help");
    r.client.emit("windowBlur");
    expect(r.client.state()).toMatchObject({ help: false, phase: "turn", ink: true });
  });

  it("selection pings move the affordance, never the modes", () => {
    const r = makeRig();
    grantAndOpen(r);
    r.bus.firePageEvent({ kind: "selectionPresent", tab: 7, present: true });
    expect(r.client.context().selectionPresent).toBe(true);
    expect(findCap(r, "selection")?.lit).toBe(true); // ledger: "selection cap
    // stuck lit" — a projection now, recomputed per read
  });
});

describe("the bar: a tree presented linearly", () => {
  it("blank system: arm · step out (disabled) · help — nothing else", () => {
    const r = makeRig();
    r.client.setContext({ connected: true });
    const rows = r.client.bar();
    expect(rows).toHaveLength(1);
    expect(rows[0].items.map((i) => (i.kind === "cap" ? i.command : ""))).toEqual([
      "arm",
      "escape",
      "help",
    ]);
    expect(findCap(r, "arm")?.enabled).toBe(true);
    expect(findCap(r, "escape")?.enabled).toBe(false); // nothing to step out of
    expect(findCap(r, "help")?.enabled).toBe(true);
  });

  it("arming requires the channel; the arm cap is the armed STATUS", () => {
    const r = makeRig();
    expect(findCap(r, "arm")?.enabled).toBe(false); // disconnected
    r.client.setContext({ connected: true });
    expect(findCap(r, "arm")?.enabled).toBe(true);
    r.client.dispatch("arm");
    expect(findCap(r, "arm")?.lit).toBe(true); // status indicator
    r.client.dispatch("arm"); // …and the same cap disarms
    expect(r.client.state().phase).toBe("disarmed");
  });

  it("each tier reveals as its parent engages; enabled derives from the machine", () => {
    const r = makeRig();
    r.client.setContext({ connected: true });
    r.client.dispatch("arm");
    expect(findCap(r, "turn")).toBeDefined(); // the armed tier
    // A turn is a WIRE concept — no grant needed (found live: the grant gate
    // dead-ended the bar for anyone who armed via the cap). The capture acts
    // below gate on the grant individually.
    expect(findCap(r, "turn")?.enabled).toBe(true);
    expect(findCap(r, "ink")).toBeUndefined(); // turn tier closed

    r.client.dispatch("turn");
    expect(r.lanes).toContain("openTurn"); // the bar's turn opens the thread too
    expect(findCap(r, "ink")).toBeDefined();
    expect(findCap(r, "send")?.enabled).toBe(true);
    // Ungranted turn: only the PIXEL verbs say no (the gate split, owner
    // 2026-07-14) — selection is a page act, gated on a selection EXISTING.
    expect(findCap(r, "shot")?.enabled).toBe(false);
    expect(findCap(r, "selection")?.enabled).toBe(false); // nothing selected yet
    r.client.setContext({ selectionPresent: true });
    expect(findCap(r, "selection")?.enabled).toBe(true);
    r.client.setContext({ grantedTab: 7 });
    expect(findCap(r, "shot")?.enabled).toBe(true);
  });

  it("push-to-talk and hands-free are separate affordances over ONE talk region", () => {
    const r = makeRig();
    grantAndOpen(r);
    const ptt = findCap(r, "talkPress");
    expect(ptt?.hold).toEqual({ down: "talkPress", up: "talkRelease" }); // press-and-HOLD
    expect(ptt?.enabled).toBe(true);

    r.client.dispatch("handsFree"); // while hands-free, the hold grip is
    expect(findCap(r, "talkPress")?.enabled).toBe(false); // unavailable — one mic
    r.client.dispatch("handsFree");
    r.client.dispatch("talkPress"); // and vice versa
    expect(findCap(r, "handsFree")?.enabled).toBe(true); // h SWITCHES grips (reduction moves talk)
    expect(r.client.state().talk).toBe("hold");
  });

  it("hands-free reveals mute; video reveals cadence — widgets included", () => {
    const r = makeRig();
    grantAndOpen(r);
    expect(findCap(r, "mute")).toBeUndefined();
    r.client.dispatch("handsFree");
    expect(findCap(r, "mute")).toBeDefined();

    r.client.dispatch("video");
    expect(findCap(r, "fpsMode")).toBeDefined();
    expect(
      flatBar(r).find((i) => i.kind === "widget" && i.control === "videoPeriodSec"),
    ).toBeUndefined(); // smart mode — no rate slider
    r.client.dispatch("fpsMode");
    expect(
      flatBar(r).find((i) => i.kind === "widget" && i.control === "videoPeriodSec"),
    ).toBeDefined();
  });

  it("labels are STABLE — engaging a mode never rewrites its cap text", () => {
    const r = makeRig();
    grantAndOpen(r);
    const before = findCap(r, "handsFree")?.hint.label;
    r.client.dispatch("handsFree");
    expect(findCap(r, "handsFree")?.hint.label).toBe(before);
    r.client.dispatch("tweak");
    expect(findCap(r, "tweak")?.hint.label).toBe("tweak");
  });

  it("the config strip carries the standing settings as control widgets", () => {
    const r = makeRig();
    const widgets = r.client
      .configStrip()
      .flatMap((row) => row.items)
      .map((i) => (i.kind === "widget" ? i.control : ""));
    expect(widgets).toEqual(["stt", "linter", "logLevel", "shotFlash"]);
  });
});

describe("projections", () => {
  it("bar and hints derive from the same state the keys act on", () => {
    const r = makeRig();
    grantAndOpen(r);
    r.client.dispatch("ink");
    expect(findCap(r, "ink")?.lit).toBe(true);
    expect(findCap(r, "clear")).toBeDefined(); // ink's child tier
    const hints = r.client.hints();
    expect(hints.find((h) => h.key === "i")?.active).toBe(true); // stable label, active flag
  });
});
