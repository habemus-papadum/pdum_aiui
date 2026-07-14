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
  barModel,
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
  /** Clear the page's ink strokes (the ONLY clearer besides disarm). */
  clearInk(tab: number): void;
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
  /** Lane hooks for the claims (real video pump, ink fade) — see claims.ts. */
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
  /** The command bar: the mode tree flattened into depth rows (reactive). */
  bar(): BarRow[];
  /** The standing config strip (one flat row of widgets; reactive). */
  configStrip(): BarRow[];
  /** The keymap help rows for the current state (reactive). */
  hints(): KeyHint[];
  engine: SolidModeEngine<IntentContext>;
}

const inTurn = (phase: unknown): boolean => phase === "turn" || phase === "tweak";

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
      case "selection":
        if (event.before.phase === "turn" && activeTab !== undefined) {
          lanes.addSelection(activeTab);
        }
        break;
      case "clear":
        if (event.before.phase === "turn" && event.before.ink === true && activeTab !== undefined) {
          lanes.clearInk(activeTab);
        }
        break;
      default:
        break;
    }

    // Talk lifecycle: derived from the talk REGION's movement so every path
    // (space, h, excludes on send/cancel/disarm/tweak) lands here.
    if (event.before.talk !== event.after.talk) {
      if (event.after.talk !== "off") {
        lanes.startTalk(event.after.talk as string);
      } else {
        lanes.stopTalk();
      }
    }
    if (event.before.micMuted !== event.after.micMuted && event.after.talk !== "off") {
      lanes.setMicMuted(event.after.micMuted === true);
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
  const noteTab = (tab: number | undefined): void => {
    engine.setContext(grantless ? { activeTab: tab, grantedTab: tab } : { activeTab: tab });
  };
  host.targeting.onActiveTabChange(noteTab);
  noteTab(host.targeting.activeTab());
  host.transport.onPageEvent((event) => {
    if (event.kind === "selectionPresent") {
      engine.setContext({ selectionPresent: event.present });
    } else if (event.kind === "keyForward") {
      handleKey(event.key, event.phase, event.repeat);
    } else if (event.kind === "aiuiSupport") {
      engine.setContext({ aiuiPage: event.supported });
    } else if (event.kind === "foreignClient") {
      engine.setContext({ foreignArmed: event.armed });
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
      barModel(intentBar, {
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
