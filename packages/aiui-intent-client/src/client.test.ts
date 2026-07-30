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
    addSelection: entry("addSelection"),
    clearPencil: entry("clearPencil"),
    clearAllPencils: entry("clearAllPencils"),
    startTalk: entry("startTalk"),
    stopTalk: entry("stopTalk"),
    setMicMuted: entry("setMicMuted"),
    setPaused: entry("setPaused"),
    setOracleMic: entry("setOracleMic"),
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

/** The retired one-gesture ritual, recomposed for the new contract (owner,
 * 2026-07-20): connecting ARMS (the edge in client.ts — a re-set while
 * connected is no edge, so re-arm by hand where a test disarmed), the
 * invocation gesture only records the grant, and the turn cap opens. */
function grantAndOpen(r: Rig, tab = 7): void {
  r.client.setContext({ connected: true });
  if (r.client.state().phase === "disarmed") {
    r.client.dispatch("arm");
  }
  activationGesture(r.client, tab);
  r.client.dispatch("turn");
}

/** All bar items, flattened across depth rows. */
// The bar is a depth-first forest now; flatten the whole subtree for lookups.
const flattenNodes = (
  nodes: ReturnType<Rig["client"]["bar"]>,
): ReturnType<Rig["client"]["bar"]>[number]["item"][] =>
  nodes.flatMap((node) => [node.item, ...flattenNodes(node.children)]);
const flatBar = (r: Rig) => flattenNodes(r.client.bar());
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

describe("the invocation gesture — grant-only (owner, 2026-07-20)", () => {
  it("records the granted tab and moves NO phase — turns belong to the turn cap", () => {
    const r = makeRig();
    r.client.setContext({ connected: true }); // the edge arms (arm-on-connect)
    expect(r.client.state().phase).toBe("armed");
    activationGesture(r.client, 7);
    expect(r.client.state().phase).toBe("armed"); // no escalation to a turn
    expect(r.client.context().grantedTab).toBe(7);
    expect(r.lanes).toEqual([]); // no openTurn
  });

  it("mid-turn it re-grants and never cancels (the one salvage kept)", () => {
    const r = makeRig();
    grantAndOpen(r);
    activationGesture(r.client, 9); // e.g. re-granting after a tab switch
    expect(r.client.state().phase).toBe("turn"); // untouched
    expect(r.client.context().grantedTab).toBe(9);
    expect(r.lanes).toEqual(["openTurn"]); // no second open, no cancel
  });

  it("with no channel the grant still records — arming is the connection's job now", () => {
    const r = makeRig(); // never connected
    activationGesture(r.client, 7);
    expect(r.client.state().phase).toBe("disarmed");
    expect(r.client.context().grantedTab).toBe(7);
    expect(r.lanes).toEqual([]);
  });
});

describe("arm follows the connection (owner, 2026-07-20)", () => {
  it("the connected edge arms a disarmed client", () => {
    const r = makeRig();
    expect(r.client.state().phase).toBe("disarmed");
    r.client.setContext({ connected: true });
    expect(r.client.state().phase).toBe("armed");
  });

  it("a re-set while connected is NO edge — a deliberate disarm sticks", () => {
    const r = makeRig();
    r.client.setContext({ connected: true });
    r.client.dispatch("disarm");
    r.client.setContext({ connected: true }); // a repeated status write
    expect(r.client.state().phase).toBe("disarmed");
  });

  it("a reconnect RE-ARMS even after a deliberate disarm (decided: simplicity wins)", () => {
    const r = makeRig();
    r.client.setContext({ connected: true });
    r.client.dispatch("disarm");
    r.client.setContext({ connected: false }); // an outage never disarms; this one found us disarmed
    r.client.setContext({ connected: true }); // the edge again
    expect(r.client.state().phase).toBe("armed");
  });

  it("a connection blip mid-turn disturbs nothing — the edge only arms from disarmed", () => {
    const r = makeRig();
    grantAndOpen(r);
    r.client.setContext({ connected: false });
    r.client.setContext({ connected: true });
    expect(r.client.state().phase).toBe("turn");
    expect(r.lanes).toEqual(["openTurn"]);
  });
});

describe("the capture grant is the HOST's business, not a ritual", () => {
  it("a grantless host lights the capture acts however you armed (found live: the bar left them dark)", async () => {
    // The CDP tier's screenshots ask nobody, so there is no grant to acquire —
    // and arming from the BAR (arm → turn), which mints nothing, must work
    // exactly like the ⌘B gesture. It did not: shot/selection stayed
    // disabled forever, and only the page acts (which follow the tab in view) worked.
    const r = makeRig({ grantless: true });
    r.client.setContext({ connected: true }); // the edge arms
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
    r.client.setContext({ connected: true }); // the edge arms
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
    r.client.dispatch("pencil");
    await settle();
    r.bus.clearLog();

    r.bus.switchTab(9); // an UNGRANTED tab
    await settle();

    expect(r.client.canDispatch("shot")).toBe(false); // pixels: dark until ⌘B here
    r.bus.firePageEvent({ kind: "selectionPresent", tab: 9, present: true });
    expect(r.client.canDispatch("selection")).toBe(true); // page act: follows the view
    expect(r.client.canDispatch("pencilClear")).toBe(true);
    // The pencil surface re-pointed at the tab in view, no grant asked.
    expect(r.bus.log.some((line) => line.startsWith("page:pencil@9"))).toBe(true);
    r.client.dispatch("selection");
    expect(r.lanes).toContain("addSelection:9");
  });

  it("jump lights only on aiui-instrumented pages — the gate IS the detection", async () => {
    // Jump-to-editor reads the page's stamps and source root; a page without
    // `__AIUI__` has nothing to jump to, so the cap grays (owner, 2026-07-15).
    // A page act: no grant involved, follows the tab in view.
    const r = makeRig();
    grantAndOpen(r);
    expect(r.client.canDispatch("jump")).toBe(false); // no __AIUI__: can't ENTER

    r.bus.firePageEvent({ kind: "aiuiSupport", tab: 7, supported: true });
    expect(r.client.canDispatch("jump")).toBe(true);
    // A TOGGLE now, not a one-shot verb (owner, 2026-07-16): dispatch turns the
    // mode on and lights the cap; the jumpSurface claim arms the page picker.
    r.client.dispatch("jump");
    expect(r.client.state().jump).toBe(true);
    expect(findCap(r, "jump")?.lit).toBe(true);

    // Once ON, toggling OFF is always allowed — a page that de-instruments (or a
    // lost grant, for area) must never strand you in a mode you can't leave.
    r.bus.firePageEvent({ kind: "aiuiSupport", tab: 7, supported: false });
    expect(r.client.canDispatch("jump")).toBe(true);
    r.client.dispatch("jump");
    expect(r.client.state().jump).toBe(false);
  });

  it("page facts are PER-TAB — a background tab's hello never describes the one in view", async () => {
    // Found live (2026-07-16): a tab switch fires visibilitychange hellos on
    // BOTH sides, and the flags were global last-writer-wins — the aiui pill
    // (and the jump/selection gates) could describe a tab you weren't looking
    // at, nondeterministically. Facts now live by tab; the context carries the
    // active tab's, re-derived on every switch.
    const r = makeRig();
    grantAndOpen(r);
    r.bus.firePageEvent({ kind: "aiuiSupport", tab: 7, supported: true });
    r.bus.firePageEvent({ kind: "selectionPresent", tab: 7, present: true });
    expect(r.client.context().aiuiPage).toBe(true);

    // The race, replayed: the BACKGROUND tab's hello lands after the active
    // tab's. It must update the map, never the view.
    r.bus.firePageEvent({ kind: "aiuiSupport", tab: 9, supported: false });
    r.bus.firePageEvent({ kind: "selectionPresent", tab: 9, present: false });
    expect(r.client.context().aiuiPage).toBe(true); // still tab 7's truth
    expect(r.client.context().selectionPresent).toBe(true);

    // Switching the view re-derives from the map — no new hello needed…
    r.bus.switchTab(9);
    await settle();
    expect(r.client.context().aiuiPage).toBe(false);
    expect(r.client.context().selectionPresent).toBe(false);

    // …and back: tab 7's remembered facts return intact.
    r.bus.switchTab(7);
    await settle();
    expect(r.client.context().aiuiPage).toBe(true);
    expect(r.client.context().selectionPresent).toBe(true);
  });

  it("pencil markup rides ARMED (C2): mode, surface, and clear — no turn needed", async () => {
    // The pencil is a page act (surface follows the tab, no grant). C2 (owner,
    // 2026-07-25): markup is a SOURCE — the durable `pencil` toggle engages the
    // surface and enables clear while merely armed; the founding complaint was
    // opening a turn just to clear ink.
    const r = makeRig();
    r.client.setContext({ connected: true }); // the edge arms
    // Mode off by default (like ink); clear rides the MODE, so it is dark.
    expect(r.client.canDispatch("pencilClear")).toBe(false);

    r.client.dispatch("pencil"); // markup mode ON — while ARMED, no turn
    await settle();
    expect(r.client.state().pencil).toBe(true);
    expect(r.bus.log).toContain('page:pencil@7 {"op":"engage","fadeSec":0}');
    expect(r.client.canDispatch("pencilClear")).toBe(true);
    r.client.dispatch("pencilClear");
    expect(r.lanes).toContain("clearPencil:7");

    // A turn changes nothing for the pencil — the mode and clear carry through.
    grantAndOpen(r);
    expect(r.client.state().pencil).toBe(true);
    expect(r.client.canDispatch("pencilClear")).toBe(true);

    // Disarm clears the mode — the hard-disarm exclude, ink's twin.
    r.client.dispatch("disarm");
    expect(r.client.state().pencil).not.toBe(true);
    // …and the STROKES: disarm is hard for the markup too (owner, 2026-07-17).
    // The sweep clears every engaged tab, not just the one in view.
    expect(r.lanes).toContain("clearAllPencils");
  });

  it("EVERY route into disarmed sweeps the strokes (d, arm-toggle, Esc floor)", async () => {
    // The `disarmed-is-hard` exclude clears the pencil MODE on all routes;
    // the strokes' half must be just as route-agnostic — it hangs off the
    // armed→disarmed transition in the verb effects, not off the `disarm`
    // command specifically.
    const r = makeRig();
    r.client.setContext({ connected: true });

    grantAndOpen(r);
    r.client.dispatch("disarm");
    expect(r.lanes.filter((l) => l === "clearAllPencils")).toHaveLength(1);

    grantAndOpen(r);
    r.client.dispatch("arm"); // the bar's arm cap pressed while armed = disarm
    expect(r.lanes.filter((l) => l === "clearAllPencils")).toHaveLength(2);

    // …but a turn ending WITHOUT disarming (send keeps the seat armed) does
    // NOT sweep — strokes are durable across turns until cleared or disarmed.
    grantAndOpen(r);
    r.client.dispatch("send");
    expect(r.client.state().phase).toBe("armed");
    expect(r.lanes.filter((l) => l === "clearAllPencils")).toHaveLength(2);
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

    r.client.setContext({ connected: true }); // armed by the edge, NOTHING granted yet
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
    r.client.setContext({ connected: true }); // the edge arms
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

    r.client.dispatch("pencil"); // standing setting, to prove the hard clear
    r.client.dispatch("escape"); // the last rung: step out of armed = disarm
    expect(r.client.state()).toMatchObject({ phase: "disarmed", pencil: false });

    const before = r.client.state();
    r.client.dispatch("escape"); // quiescent: nothing left to step out of
    expect(r.client.state()).toBe(before);
  });

  it("disarm abandons everything: turn cancelled, pencil off, pointer released", async () => {
    const r = makeRig();
    grantAndOpen(r);
    r.client.dispatch("pencil");
    await settle();
    expect(r.bus.log).toContain('page:pencil@7 {"op":"engage","fadeSec":0}');

    r.client.dispatch("disarm");
    await settle();
    expect(r.lanes).toContain("cancelTurn");
    expect(r.client.state()).toMatchObject({ phase: "disarmed", pencil: false });
    expect(r.bus.log).toContain('page:pencil@7 {"op":"disengage"}'); // claim released
    expect(r.bus.heldStreams()).toEqual([]); // warm stream let go
  });
});

describe("claims — the end of hand-called syncs", () => {
  it("pencil mid-turn asserts the surface with no sync call anywhere", async () => {
    const r = makeRig();
    grantAndOpen(r);
    await settle();
    r.bus.clearLog();
    r.client.dispatch("pencil"); // ledger (F2): "caps stale after selection change",
    await settle(); //              "command bar completely missing" — the class
    expect(r.bus.log).toContain('page:pencil@7 {"op":"engage","fadeSec":0}');
  });

  it("the warm stream is ARMED-scoped: survives the turn, releases on disarm (C1)", async () => {
    const r = makeRig();
    grantAndOpen(r);
    await settle();
    expect(r.bus.heldStreams()).toEqual([7]);

    // C1 (owner, 2026-07-25): video is a SOURCE — a turn is not the power
    // switch. Send returns to armed; the stream stays warm (the iPad mirror
    // keeps running, the next shot rides the same warmth).
    r.client.dispatch("send");
    await settle();
    expect(r.bus.heldStreams()).toEqual([7]);

    // Only disarm ends the source.
    r.client.dispatch("disarm");
    await settle();
    expect(r.bus.heldStreams()).toEqual([]);
  });

  it('key routing is ARMED-level (C3\'): the claimed SET while armed, "all" in a turn', async () => {
    const r = makeRig();
    r.client.setContext({ connected: true }); // the edge arms — no turn yet
    await settle();
    // Armed: the page claim is the armed grammar's live bound set.
    const armedClaim = r.bus.log.find((l) => l.startsWith("page:keylayer@7"));
    expect(armedClaim).toBeDefined();
    expect(armedClaim).toContain('"capture":true');
    expect(armedClaim).toContain('"Enter"');
    expect(armedClaim).toContain('"h"');
    expect(armedClaim).not.toContain('"all"');
    expect(armedClaim).not.toContain('"c"'); // pencil off ⇒ its clear unclaimed
    expect(armedClaim).not.toContain("Escape"); // NEVER claimed outside a turn

    r.client.dispatch("pencil"); // pencil on ⇒ `c` joins the armed set
    await settle();
    expect(r.bus.log.filter((l) => l.includes('"c"')).length).toBeGreaterThan(0);
    r.client.dispatch("pencil");

    grantAndOpen(r);
    await settle();
    expect(r.bus.log).toContain('page:keylayer@7 {"capture":true,"keys":"all"}');

    r.bus.switchTab(9); // ledger: tab switch re-points capture
    await settle();
    expect(r.bus.log).toContain('page:keylayer@7 {"capture":false}');
    expect(r.bus.log).toContain('page:keylayer@9 {"capture":true,"keys":"all"}');
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
    r.bus.failCapability("pencil", "surface refused");
    const errors: unknown[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args);
    });
    grantAndOpen(r);
    r.client.dispatch("pencil");
    await settle();
    expect(r.client.claimStatuses().pencilSurface?.phase).toBe("error");
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

  it("hands-free STANDS across a send; the WINDOW closes and reopens with the turn (C3')", () => {
    const r = makeRig();
    grantAndOpen(r);
    r.client.dispatch("handsFree");
    expect(r.client.state().talk).toBe("handsFree");
    expect(r.lanes).toContain("startTalk:handsFree");

    r.client.dispatch("send"); // the mode SURVIVES; the window (capture) ends
    expect(r.client.state().talk).toBe("handsFree");
    expect(r.lanes).toContain("stopTalk");

    r.client.dispatch("turn"); // the next turn reopens the window by itself
    expect(r.lanes.filter((l) => l === "startTalk:handsFree")).toHaveLength(2);
  });

  it("hands-free while merely ARMED opens no window — nothing records until a turn routes it", () => {
    const r = makeRig();
    r.client.setContext({ connected: true }); // armed, no turn
    r.client.dispatch("handsFree");
    expect(r.client.state().talk).toBe("handsFree");
    expect(r.lanes).not.toContain("startTalk:handsFree");

    r.client.dispatch("turn");
    expect(r.lanes).toContain("startTalk:handsFree");
  });

  it("disarm ends the standing mode AND the window (disarmed-is-hard widened)", () => {
    const r = makeRig();
    grantAndOpen(r);
    r.client.dispatch("handsFree");
    r.client.dispatch("disarm");
    expect(r.client.state().talk).toBe("off");
    expect(r.lanes).toContain("stopTalk");
  });
});

describe("pause — the sink suspends, the turn survives (owner, 2026-07-30)", () => {
  it("pausing a hands-free turn closes the WINDOW; resuming reopens it; the mode stands", () => {
    const r = makeRig();
    grantAndOpen(r);
    r.client.dispatch("handsFree");
    expect(r.lanes).toContain("startTalk:handsFree");

    r.client.dispatch("pause");
    expect(r.client.state()).toMatchObject({ phase: "turn", paused: true, talk: "handsFree" });
    expect(r.lanes).toContain("stopTalk"); // the window closed…
    expect(r.lanes).toContain("setPaused:true"); // …and the lane got the bracket edge

    r.client.dispatch("pause"); // resume
    expect(r.lanes).toContain("setPaused:false");
    expect(r.lanes.filter((l) => l === "startTalk:handsFree")).toHaveLength(2); // reopened itself
  });

  it("the stream reads bracket-first: setPaused lands BEFORE the talk verbs on both edges", () => {
    const r = makeRig();
    grantAndOpen(r);
    r.client.dispatch("handsFree");
    r.client.dispatch("pause");
    expect(r.lanes.indexOf("setPaused:true")).toBeLessThan(r.lanes.lastIndexOf("stopTalk"));
    r.client.dispatch("pause");
    expect(r.lanes.indexOf("setPaused:false")).toBeLessThan(
      r.lanes.lastIndexOf("startTalk:handsFree"),
    );
  });

  it("a paused turn refuses shot and selection at dispatch — no lane verb fires", () => {
    const r = makeRig();
    grantAndOpen(r);
    r.client.setContext({ selectionPresent: true });
    r.client.dispatch("pause");
    r.client.dispatch("shot");
    r.client.dispatch("selection");
    expect(r.lanes).not.toContain("takeShot:7");
    expect(r.lanes).not.toContain("addSelection:7");
    r.client.dispatch("pause"); // resume — the same routes act again
    r.client.dispatch("shot");
    r.client.dispatch("selection");
    expect(r.lanes).toContain("takeShot:7");
    expect(r.lanes).toContain("addSelection:7");
  });

  it("video sampling stops with the pause and restarts on resume — the MODE stays lit", async () => {
    const r = makeRig();
    grantAndOpen(r);
    r.client.dispatch("video");
    await settle();
    expect(r.client.claimStatuses().videoSample?.phase).toBe("active");

    r.client.dispatch("pause");
    await settle();
    expect(r.client.state().video).toBe(true); // standing mode untouched
    expect(r.bus.log).toContain('page:viewport@7 {"sample":false}'); // the pump released

    r.client.dispatch("pause");
    await settle();
    expect(r.client.claimStatuses().videoSample?.phase).toBe("active"); // re-acquired
  });

  it("b toggles the pause from the keyboard (page or panel — the claim is unchanged)", () => {
    const r = makeRig();
    grantAndOpen(r);
    r.client.handleKey("b", "down", false);
    expect(r.client.state().paused).toBe(true);
    r.client.handleKey("b", "down", false);
    expect(r.client.state().paused).toBe(false);
    expect(r.blips).toEqual([]); // a bound key, never a typo
  });

  it("cancel-while-paused relays the exit edge (the gate resets; the close is the outer bracket)", () => {
    const r = makeRig();
    grantAndOpen(r);
    r.client.dispatch("pause");
    r.client.dispatch("cancelTurn");
    expect(r.client.state()).toMatchObject({ phase: "armed", paused: false });
    expect(r.lanes).toContain("cancelTurn"); // the explicit cancel cancels the thread
    expect(r.lanes).toContain("setPaused:false"); // the exit edge still relays
  });

  it("cancelTurn is the escape family: it cancels the thread and keeps the seat armed", () => {
    const r = makeRig();
    grantAndOpen(r);
    r.client.dispatch("cancelTurn");
    expect(r.client.state().phase).toBe("armed");
    expect(r.lanes).toContain("cancelTurn");
    r.client.dispatch("cancelTurn"); // outside a turn: refused, nothing fires
    expect(r.lanes.filter((l) => l === "cancelTurn")).toHaveLength(1);
  });
});

describe("the oracle — a second sink in the panel (O3a)", () => {
  /** The oracle needs a channel and a mic that wasn't refused. */
  const armWithMic = (r: Rig): void => {
    r.client.setContext({ connected: true, micGranted: true });
  };

  it("the session is a CLAIM: the desire acquires it, dropping the desire releases it", async () => {
    const r = makeRig();
    const started: number[] = [];
    const stopped: number[] = [];
    await r.client.dispose();
    const bus = fakeBus({ activeTab: 7 });
    const lanes: string[] = [];
    const client = createIntentClient({
      host: bus,
      lanes: fakeLanes(lanes),
      claimOptions: {
        oracle: {
          start: async () => {
            started.push(1);
          },
          stop: () => stopped.push(1),
        },
      },
    });
    rig = { client, bus, lanes, blips: [] };
    client.setContext({ connected: true, micGranted: true });
    await settle();
    expect(client.claimStatuses().oracleSession?.phase).toBe("idle");

    client.dispatch("oracle");
    await settle();
    expect(started).toHaveLength(1);
    expect(client.claimStatuses().oracleSession?.phase).toBe("active");

    client.dispatch("oracle");
    await settle();
    expect(stopped).toHaveLength(1);
    expect(client.claimStatuses().oracleSession?.phase).toBe("idle");
  });

  it("a failed connect lands as the claim's ERROR — the pill's truth, not a flag out of step", async () => {
    await rig?.client.dispose();
    const bus = fakeBus({ activeTab: 7 });
    const client = createIntentClient({
      host: bus,
      lanes: fakeLanes([]),
      claimOptions: {
        oracle: {
          start: () => Promise.reject(new Error("no OPENAI_API_KEY in the channel")),
          stop: () => {},
        },
      },
    });
    rig = { client, bus, lanes: [], blips: [] };
    client.setContext({ connected: true, micGranted: true });
    client.dispatch("oracle");
    await settle(30);
    expect(client.claimStatuses().oracleSession?.phase).toBe("error");
    // The DESIRE stands — the user asked for a session; the world refused. The
    // cap stays lit and pressing it again is the retry.
    expect(client.state().oracle).toBe(true);
  });

  it("taking the sink suspends the turn — the same bracket a manual pause makes", () => {
    const r = makeRig();
    grantAndOpen(r);
    r.client.dispatch("oracle");
    expect(r.client.state()).toMatchObject({ phase: "turn", oracle: true, paused: false });
    // The lane's gate follows turnSuspended, not the `paused` region — so an
    // oracle detour brackets the stream and suppresses boundaries too.
    expect(r.lanes).toContain("setPaused:true");
    r.client.dispatch("oracle");
    expect(r.lanes).toContain("setPaused:false");
  });

  it("the turn's talk window closes on the handover and the oracle's mic opens", () => {
    const r = makeRig();
    grantAndOpen(r);
    r.client.dispatch("handsFree");
    expect(r.lanes).toContain("startTalk:handsFree");

    r.client.dispatch("oracle");
    expect(r.lanes).toContain("stopTalk"); // the turn stops capturing…
    expect(r.lanes).toContain("setOracleMic:true"); // …and the oracle starts hearing
    expect(r.client.state().talk).toBe("handsFree"); // the GRIP is untouched

    r.client.dispatch("oracle");
    expect(r.lanes).toContain("setOracleMic:false");
    expect(r.lanes.filter((l) => l === "startTalk:handsFree")).toHaveLength(2); // turn resumes
  });

  it("the oracle does not listen on activation — it inherits the grip (no hot mic)", () => {
    const r = makeRig();
    armWithMic(r); // armed, no turn, talk off
    r.client.dispatch("oracle");
    expect(r.lanes).not.toContain("setOracleMic:true");
    r.client.dispatch("handsFree"); // NOW it hears
    expect(r.lanes).toContain("setOracleMic:true");
  });

  it("park, mute, and dropping the grip each gate the mic; any one of them is enough", () => {
    const r = makeRig();
    armWithMic(r);
    r.client.dispatch("oracle");
    r.client.dispatch("handsFree");
    expect(r.lanes.at(-1)).toBe("setOracleMic:true");

    r.client.dispatch("oraclePark");
    expect(r.lanes.at(-1)).toBe("setOracleMic:false");
    r.client.dispatch("oraclePark");
    expect(r.lanes.at(-1)).toBe("setOracleMic:true");

    r.client.dispatch("mute");
    expect(r.lanes.at(-1)).toBe("setOracleMic:false");
    r.client.dispatch("mute");
    expect(r.lanes.at(-1)).toBe("setOracleMic:true");

    r.client.dispatch("handsFree"); // the grip goes away
    expect(r.lanes.at(-1)).toBe("setOracleMic:false");
  });

  it("disarm closes the session and gates the mic (disarmed-is-hard)", async () => {
    const r = makeRig();
    armWithMic(r);
    r.client.dispatch("oracle");
    r.client.dispatch("handsFree");
    await settle();
    r.client.dispatch("disarm");
    await settle();
    expect(r.client.state().oracle).toBe(false);
    expect(r.lanes).toContain("setOracleMic:false");
    expect(r.client.claimStatuses().oracleSession?.phase).toBe("idle");
  });

  it("`o` toggles it from the keyboard, armed or in a turn", () => {
    const r = makeRig();
    armWithMic(r);
    r.client.handleKey("o", "down", false);
    expect(r.client.state().oracle).toBe(true);
    r.client.handleKey("o", "down", false);
    expect(r.client.state().oracle).toBe(false);
    grantAndOpen(r);
    r.client.handleKey("o", "down", false);
    expect(r.client.state().oracle).toBe(true);
    expect(r.blips).toEqual([]); // a bound key in both layers, never a typo
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
    r.client.handleKey("k", "down", false);
    expect(r.client.state().pencil).toBe(false); // not in turn: the page keeps `k`
    expect(r.blips).toEqual([]);
  });

  it("forwarded page keys take the identical path", () => {
    const r = makeRig();
    grantAndOpen(r);
    r.bus.firePageEvent({ kind: "keyForward", tab: 7, key: "k", phase: "down", repeat: false });
    expect(r.client.state().pencil).toBe(true);
  });
});

describe("system events", () => {
  it("the wire closing the thread returns the seat to armed", () => {
    const r = makeRig();
    grantAndOpen(r);
    r.client.emit("turnClosed"); // ledger: idle-timeout / server-side close
    expect(r.client.state().phase).toBe("armed");
  });

  it("window blur moves nothing — help included (a reference card you read while the page has focus)", () => {
    const r = makeRig();
    grantAndOpen(r);
    r.client.dispatch("pencil");
    r.client.dispatch("help");
    r.client.emit("windowBlur");
    expect(r.client.state()).toMatchObject({ help: true, phase: "turn", pencil: true });
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
    r.client.setContext({ connected: true }); // the edge arms…
    r.client.dispatch("disarm"); // …step back down to the blank system
    const roots = r.client.bar();
    // Depth-first forest: the blank system's roots ARE the whole bar (no lit
    // parent, so nothing is revealed beneath them).
    expect(roots.every((node) => node.children.length === 0)).toBe(true);
    expect(roots.map((node) => (node.item.kind === "cap" ? node.item.command : ""))).toEqual([
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
    r.client.setContext({ connected: true }); // the edge arms on its own
    expect(findCap(r, "arm")?.lit).toBe(true); // status indicator
    r.client.dispatch("arm"); // the same cap disarms…
    expect(r.client.state().phase).toBe("disarmed");
    expect(findCap(r, "arm")?.enabled).toBe(true); // …and can re-arm by hand
    r.client.dispatch("arm");
    expect(findCap(r, "arm")?.lit).toBe(true);
  });

  it("each tier reveals as its parent engages; enabled derives from the machine", () => {
    const r = makeRig();
    r.client.setContext({ connected: true }); // the edge arms
    expect(findCap(r, "turn")).toBeDefined(); // the armed tier
    // A turn is a WIRE concept — no grant needed (found live: the grant gate
    // dead-ended the bar for anyone who armed via the cap). The capture acts
    // below gate on the grant individually.
    expect(findCap(r, "turn")?.enabled).toBe(true);
    // C2: the pencil lives on the ARMED tier — togglable with no turn open
    // (markup is a source). Since the hoist (owner, 2026-07-30) `shot` lives
    // there too — VISIBLE but refused with no sink; the lifecycle cluster
    // (send · pause · cancel) stays behind the closed turn tier.
    expect(findCap(r, "pencil")).toBeDefined();
    expect(findCap(r, "shot")).toBeDefined(); // hoisted — present while armed…
    expect(findCap(r, "shot")?.enabled).toBe(false); // …but no sink yet
    expect(findCap(r, "send")).toBeUndefined(); // turn tier closed
    expect(findCap(r, "pause")).toBeUndefined();

    r.client.dispatch("turn");
    expect(r.lanes).toContain("openTurn"); // the bar's turn opens the thread too
    expect(findCap(r, "pencil")).toBeDefined();
    expect(findCap(r, "send")?.enabled).toBe(true);
    expect(findCap(r, "pause")?.enabled).toBe(true); // the lifecycle cluster
    expect(findCap(r, "cancelTurn")?.enabled).toBe(true);
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
    // The cadence is a MODE SELECT + an always-visible slider now (owner,
    // 2026-07-25) — the "constant" cap whose unlit state didn't read as
    // "smart" is gone; the slider dims via enabledWhen unless constant.
    expect(flatBar(r).find((i) => i.kind === "widget" && i.control === "videoMode")).toBeDefined();
    const slider = () =>
      flatBar(r).find((i) => i.kind === "widget" && i.control === "videoPeriodSec") as
        | { enabled: boolean }
        | undefined;
    expect(slider()).toBeDefined(); // always visible…
    expect(slider()?.enabled).toBe(false); // …but DIMMED in smart mode
    r.client.dispatch("fpsMode");
    expect(slider()?.enabled).toBe(true); // constant: the slider is live
  });

  it("labels are STABLE — engaging a mode never rewrites its cap text", () => {
    const r = makeRig();
    grantAndOpen(r);
    const before = findCap(r, "handsFree")?.hint.label;
    r.client.dispatch("handsFree");
    expect(findCap(r, "handsFree")?.hint.label).toBe(before);
    r.client.dispatch("pencil");
    expect(findCap(r, "pencil")?.hint.label).toBe("pencil");
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
    r.client.dispatch("pencil");
    expect(findCap(r, "pencil")?.lit).toBe(true);
    expect(findCap(r, "pencilClear")).toBeDefined(); // pencil's child tier
    const hints = r.client.hints();
    expect(hints.find((h) => h.key === "k")?.active).toBe(true); // stable label, active flag
  });
});
