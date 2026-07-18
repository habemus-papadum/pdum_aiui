/**
 * client.ts — the whole client, one constructor: the mode engine on the
 * intent spec, the claims over an injected host, the verb effects, the key
 * entry point, and the bar model. No chrome.*, no CDP, no DOM: the host is
 * a parameter (FakeBus in tests and the dev harness, ExtensionBus/CdpBus
 * later), the lanes are a parameter (the wire/talk/shot verbs), and every
 * behavior is exercisable as `client.dispatch(...)` + host assertions.
 *
 * State writes: exactly one path (engine dispatch, flush()-committed).
 * Outbound obligations: exactly one mechanism (claims). One-shot verbs
 * (send/cancel/shot/selection/clear): the dispatch-event effect map below —
 * driven by the event, never by polling state, never hand-synced.
 */

import { type SolidModeEngine, solidModeEngine } from "@habemus-papadum/aiui-viz";
import {
  type BarRow,
  type BarTreeNode,
  barModel,
  barTree,
  type DispatchEvent,
  type KeyHint,
} from "@habemus-papadum/aiui-viz/modal";
import { configBar, intentBar } from "./caps";
import { type ClaimLaneOptions, intentClaims } from "./claims";
import { hintsFor, keyVerdict } from "./keys";
import { type IntentContext, initialContext, intentSpec } from "./spec";
import type { IntentHost } from "./transport";
// The standing config surface: importing registers the controls (durable,
// agent-visible) that the bar's widget nodes bind by name.
import "./config";

/** The turn/wire verbs the client drives (the lanes own the transport). */
export interface IntentLanes {
  /** Open the intent thread (⌘B entered a turn). */
  openTurn(): void;
  /** Commit and close the open thread (Enter). */
  sendTurn(): void;
  /** Abandon the open thread (esc rung, disarm). */
  cancelTurn(): void;
  /** One manual shot into the turn (flash on the page; sampled frames never flash). */
  takeShot(tab: number): void;
  /** Pull the page's current selection into the turn. */
  addSelection(tab: number): void;
  /** Clear the pencil surface. */
  clearPencil(tab: number): void;
  /**
   * Disarm's stroke sweep: clear EVERY pencil surface engaged since the last
   * sweep (a mid-turn tab switch leaves strokes on more than one tab).
   * Disarm is hard (spec `disarmed-is-hard` clears the pencil MODE); this is
   * the strokes' half of that hardness (owner, 2026-07-17). Optional: hosts
   * that never engage a pencil (tests' fakes) omit it.
   */
  clearAllPencils?(): void;
  /** Talk window lifecycle (mode: hold | handsFree). */
  startTalk(mode: string): void;
  stopTalk(): void;
  setMicMuted(muted: boolean): void;
  /**
   * The seat's armed-ness changed (any route). Optional: hosts whose wire
   * engine tracks armed-ness implement it (the wire Engine gates openTurn
   * and talk on it, and its setArmed(false) is its own full abandon).
   */
  setArmed?(on: boolean): void;
}

export interface IntentClientConfig {
  host: IntentHost;
  lanes: IntentLanes;
  /** Lane hooks for the claims (real video pump, pencil fade) — see claims.ts. */
  claimOptions?: ClaimLaneOptions;
  /** Trace sink — every dispatch (mode timelines in the debug UI). */
  onDispatch?: (event: DispatchEvent) => void;
  /** A swallowed in-turn typo — flash it (UI blip line + page miss-flash). */
  onBlip?: (key: string) => void;
}

export interface IntentClient
  extends Pick<
    SolidModeEngine<IntentContext>,
    | "state"
    | "region"
    | "context"
    | "dispatch"
    | "emit"
    | "setContext"
    | "claimStatuses"
    | "dispose"
  > {
  /** One key event, resolved through the grammar to a dispatch (or blip). */
  handleKey(key: string, phase: "down" | "up", repeat: boolean): void;
  /** Derived availability — would this command do anything right now? */
  canDispatch(command: string, payload?: unknown): boolean;
  /** The command bar: the mode tree as a DEPTH-FIRST pre-order forest — a
   * parent sits immediately before its revealed children so the UI brackets
   * each into one shaded group (reactive). */
  bar(): BarTreeNode[];
  /** The standing config strip (one flat row of widgets; reactive). */
  configStrip(): BarRow[];
  /** The keymap help rows for the current state (reactive). */
  hints(): KeyHint[];
  engine: SolidModeEngine<IntentContext>;
}

const inTurn = (phase: unknown): boolean => phase === "turn" || phase === "tweak";

/** The mic is silenced by the user's toggle OR by the tweak pause: tweak hands
 * keys to the page and quiets the mic without ending the talk window (spec.ts
 * `handsfree-off-turn` keeps the window open), so the linter window survives
 * and the mic resumes on return to the turn. */
const effectiveMuted = (s: { micMuted?: unknown; phase?: unknown }): boolean =>
  s.micMuted === true || s.phase === "tweak";

export function createIntentClient(config: IntentClientConfig): IntentClient {
  const { host, lanes } = config;

  /**
   * The verb effects: one-shot lane calls keyed off the DISPATCH EVENT (not
   * off state — send and cancel both land on "armed"; the command is the
   * difference). Runs before the engine's own trace sink so a trace shows
   * verbs in order.
   */
  const runVerbs = (event: DispatchEvent): void => {
    const enteredTurn = !inTurn(event.before.phase) && inTurn(event.after.phase);
    const leftTurn = inTurn(event.before.phase) && !inTurn(event.after.phase);
    // The doctrine (spec.ts `available`): page acts follow the tab in view;
    // only pixels follow the grant.
    const { grantedTab, activeTab } = engine.context();

    // Armed-ness first (the wire engine gates turn-opening on it), then
    // opening — command-agnostic (the bar's turn cap, the activation
    // gesture); closing is command-SPECIFIC: send commits, escape/disarm/arm
    // abandon, and turnEnded means the wire already closed it.
    const wasArmed = event.before.phase !== "disarmed";
    const isArmed = event.after.phase !== "disarmed";
    if (wasArmed !== isArmed) {
      lanes.setArmed?.(isArmed);
      if (!isArmed) {
        // Disarm is HARD: the `disarmed-is-hard` exclude cleared the pencil
        // MODE in this same commit; the strokes go with it (owner, 2026-07-17).
        // Every tab that got a pencil surface this session is swept — the
        // pencilSurface claim's release only disengages (strokes stay for
        // mid-turn mode flips and tab switches; disarm is the actual end).
        lanes.clearAllPencils?.();
      }
    }
    if (enteredTurn) {
      lanes.openTurn();
    }
    switch (event.command) {
      case "send":
        if (leftTurn) {
          lanes.sendTurn();
        }
        break;
      case "escape":
      case "disarm":
      case "arm":
      case "turn": // the toggle: pressed mid-turn, it abandons (owner 2026-07-14)
        if (leftTurn) {
          lanes.cancelTurn();
        }
        break;
      case "shot":
        if (event.before.phase === "turn" && grantedTab !== undefined) {
          lanes.takeShot(grantedTab);
        }
        break;
      // NOTE: no `region`/`jump` cases — those are TOGGLE modes now (owner,
      // 2026-07-16), not verbs. The regionSurface/jumpSurface claims arm and
      // lower the page overlays as the toggle flips; the claim reconciler owns
      // the page act. Auto-exit (a completed drag / pick flips the mode off)
      // rides the page-event handler below, not this dispatch switch.
      case "selection":
        if (event.before.phase === "turn" && activeTab !== undefined) {
          lanes.addSelection(activeTab);
        }
        break;
      case "pencilClear":
        // A page act — clears the pencil surface on the tab in view (no grant).
        if (event.before.phase === "turn" && activeTab !== undefined) {
          lanes.clearPencil(activeTab);
        }
        break;
      default:
        break;
    }

    // Talk lifecycle: derived from the talk REGION's movement so every path
    // (space, h, excludes on send/cancel/disarm) lands here. Entering tweak no
    // longer moves the talk region (hands-free survives it; see spec.ts), so a
    // talk window is opened/closed only on a real region change.
    if (event.before.talk !== event.after.talk) {
      if (event.after.talk !== "off") {
        lanes.startTalk(event.after.talk as string);
      } else {
        lanes.stopTalk();
      }
    }
    // Effective mute = the user's toggle OR the tweak pause. Tweak keeps the
    // hands-free window OPEN (no talk-end, so the server-side linter window
    // isn't triggered) but silences the mic; stepping back to the turn resumes
    // it. So the mic obeys `micMuted || phase === "tweak"`, and we relay only
    // when that effective value actually flips (and a window is open to mute).
    const muteBefore = event.before.talk !== "off" && effectiveMuted(event.before);
    const muteAfter = event.after.talk !== "off" && effectiveMuted(event.after);
    if (event.after.talk !== "off" && muteBefore !== muteAfter) {
      lanes.setMicMuted(muteAfter);
    }
  };

  const engine = solidModeEngine<IntentContext>({
    spec: intentSpec,
    context: initialContext,
    claims: intentClaims(host, config.claimOptions),
    onDispatch: (event) => {
      runVerbs(event);
      config.onDispatch?.(event);
    },
  });

  // World facts flow in: tab switches re-point targeting-derived claims;
  // page events update affordances (selection dot) without touching modes.
  //
  // A GRANTLESS host (CDP: screenshots ask nobody) has no grant to acquire, so
  // the grant is simply "the tab in view" — kept in lockstep here. Two bugs die
  // with this: arming from the BAR left the capture acts dark forever (only the
  // activation gesture minted a grant — found live), and the grant stayed
  // pinned to the tab it was minted on, so shots could not follow a tab switch
  // the way BEHAVIOR.md says they do in this tier.
  const grantless = host.capture.grantless === true;

  // Page facts are PER-TAB facts (owner, 2026-07-16). They used to be written
  // straight into the global context by WHICHEVER tab reported last — and a
  // tab switch fires visibilitychange hellos on BOTH sides, so two hellos
  // raced and the loser's facts (aiui pill, the jump gate, the selection dot)
  // could describe a tab you are not looking at.
  // Facts now live in a by-tab map; the context carries the ACTIVE tab's,
  // re-derived on every switch and on every event for the tab in view.
  // (Entries for closed tabs linger — two booleans a tab; nothing reads a
  // dead tab's entry, since derivation only ever follows the active id.)
  const tabFacts = new Map<number, { aiui?: boolean; selection?: boolean }>();
  const factsFor = (tab: number): { aiui?: boolean; selection?: boolean } => {
    let facts = tabFacts.get(tab);
    if (facts === undefined) {
      facts = {};
      tabFacts.set(tab, facts);
    }
    return facts;
  };
  const deriveTabFacts = (tab: number | undefined): void => {
    const facts = tab !== undefined ? tabFacts.get(tab) : undefined;
    engine.setContext({
      selectionPresent: facts?.selection === true,
      aiuiPage: facts?.aiui === true,
    });
  };

  const noteTab = (tab: number | undefined): void => {
    engine.setContext(grantless ? { activeTab: tab, grantedTab: tab } : { activeTab: tab });
    deriveTabFacts(tab);
  };
  host.targeting.onActiveTabChange(noteTab);
  noteTab(host.targeting.activeTab());
  host.transport.onPageEvent((event) => {
    if (event.kind === "selectionPresent") {
      factsFor(event.tab).selection = event.present;
    } else if (event.kind === "keyForward") {
      handleKey(event.key, event.phase, event.repeat);
      return;
    } else if (event.kind === "aiuiSupport") {
      factsFor(event.tab).aiui = event.supported;
    } else if (event.kind === "regionDrag") {
      // Area mode auto-exits after a drag (owner, 2026-07-16): the lanes crop +
      // upload the shot on this same event; here we flip the mode off so the cap
      // unlights and the regionSurface claim lowers the overlay. Force-off, not a
      // toggle — a stray double-report can't turn area back ON.
      engine.dispatch("regionDone");
      return;
    } else if (event.kind === "jumpDone") {
      // Jump mode auto-exits on a commit/cancel — the page's completion signal.
      engine.dispatch("jumpDone");
      return;
    } else {
      return;
    }
    if (event.tab === engine.context().activeTab) {
      deriveTabFacts(event.tab);
    }
  });

  const handleKey = (key: string, phase: "down" | "up", repeat: boolean): void => {
    const verdict = keyVerdict(engine.state(), key, phase, repeat);
    if (verdict.kind === "command") {
      engine.dispatch(verdict.command);
    } else if (verdict.kind === "blip") {
      config.onBlip?.(verdict.key);
    }
  };

  return {
    state: engine.state,
    region: engine.region,
    context: engine.context,
    dispatch: engine.dispatch,
    emit: engine.emit,
    setContext: engine.setContext,
    claimStatuses: engine.claimStatuses,
    dispose: engine.dispose,
    handleKey,
    canDispatch: engine.canDispatch,
    bar: () =>
      barTree(intentBar, {
        state: engine.state(),
        ctx: engine.context(),
        claims: engine.claimStatuses(),
        canDispatch: engine.canDispatch,
      }),
    configStrip: () =>
      barModel(configBar, {
        state: engine.state(),
        ctx: engine.context(),
        claims: engine.claimStatuses(),
        canDispatch: engine.canDispatch,
      }),
    hints: () => hintsFor(engine.state()),
    engine,
  };
}
