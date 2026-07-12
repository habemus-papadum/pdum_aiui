/**
 * The side panel — the per-window brain. Step 4: the turn lives here. One
 * intent-pipeline Engine per panel document; content scripts relay selections
 * up, the armed state broadcasts down to their indicators, and Send commits
 * the lowered prompt into the bound channel's Claude session.
 *
 * Step 5 adds capture: whole-viewport shots over the SW/offscreen tabCapture
 * path (invocation-gated, picker-free), per-tab ink relayed as stroke events,
 * and tab provenance — `tabs.onActivated` emits the context boundary on an
 * open turn and applies the ink-clear rule (mirroring the SPA navigation rule).
 */

import {
  type AppSelection,
  composeIntent,
  Engine,
  type Rect,
} from "@habemus-papadum/aiui-dev-overlay/intent-pipeline";
import { openIntentThread } from "@habemus-papadum/aiui-dev-overlay/intent-thread";
import { isErrorMessage } from "@habemus-papadum/aiui-dev-overlay/protocol";
import { createWire } from "@habemus-papadum/aiui-dev-overlay/wire";
import { CellView } from "@habemus-papadum/aiui-viz";
import { isTypingTarget } from "@habemus-papadum/aiui-viz/modal";
import {
  injectPaneStyles,
  Pane,
  PaneStack,
  relayRequest,
  relayRequestTab,
} from "@habemus-papadum/aiui-webext";
import { render } from "@solidjs/web";
import { createEffect, createSignal } from "solid-js";
import { dataUrlToBytes, isNotInvokedError, type ShotGrab } from "../capture";
import { ConnectionChip } from "./connection-chip";
import { createKeysIsland, type KeysIsland } from "./keys-view";
import {
  LEADER_BLIP_MS,
  type LeaderAction,
  type LeaderState,
  leaderKeyEvent,
  leaderPendingFresh,
  type PendingLeader,
} from "./leader";
import { logDebug, logInfo } from "./log";
import { graph } from "./model/graph";
import { inkFade, inkMode, shotFlash, uiScale } from "./model/store";
import { createPreviewIsland, type PreviewIsland } from "./preview-pane";
import { createSession } from "./session";
import { Toasts, toast } from "./toasts";
import { connectToolsLink } from "./tools-link";
import { TracePane } from "./trace-pane";
import { currentThreadEvents, panelIntentConfig, turnMirror } from "./turn";
import { TurnPane } from "./turn-pane";

// Sizes in rem (the browser's accessibility default × the panel zoom — see
// index.html), colors through the :root tokens it defines. Hairline borders
// stay px on purpose.
const PANEL_STYLES = `
  .hdr { display: flex; align-items: center; gap: 0.5rem; margin: 0.125rem 0.125rem 0.625rem; }
  .hdr .mark { color: var(--accent); font-weight: 700; }
  .hdr .win { margin-left: auto; color: var(--muted); font: 0.6875rem ui-monospace, monospace; }
  /* Status pills: chip-shaped BUTTONS (armed, turn) — dot + word, lit when
     on, gray when off, disabled when unreachable. Pure readers of the phase
     signal; clicks call the machine's verbs. */
  .pill {
    display: inline-flex; align-items: center; gap: 0.3125rem;
    font: 0.6875rem ui-monospace, monospace; color: var(--text-2);
    border: 1px solid var(--border); border-radius: 999px; padding: 0.125rem 0.5rem;
    background: transparent; cursor: pointer;
  }
  .pill .dot { width: 0.4375rem; height: 0.4375rem; border-radius: 50%; background: var(--dot); }
  .pill.on { background: var(--ok-bg); border-color: var(--ok-border); color: var(--ok); }
  .pill.on .dot { background: var(--ok); }
  .pill:disabled { opacity: 0.45; cursor: default; }
  .pill:hover:not(:disabled):not(.on) { background: var(--surface-2); }
  /* The turn pill lights BLUE (armed stays green): composing is the accent
     state, not another "ok" (decided 2026-07-12). */
  .pill.turn.on { background: var(--accent-bg); border-color: var(--accent-border); color: var(--accent); }
  .pill.turn.on .dot { background: var(--accent); }
  .chip {
    display: inline-flex; align-items: center; gap: 0.3125rem;
    font: 0.6875rem ui-monospace, monospace; color: var(--text-2);
    border: 1px solid var(--border); border-radius: 999px; padding: 0.125rem 0.5rem;
    background: transparent; cursor: pointer;
  }
  .chip .dot { width: 0.4375rem; height: 0.4375rem; border-radius: 50%; background: var(--dot); }
  .chip.on .dot { background: var(--ok); }
  .chip.connecting .dot { background: var(--warn); }
  .chip:hover { background: var(--surface-2); }
  /* The connection dropdown's surface (the Dropdown widget owns geometry
     only; the host styles the popup). */
  .drop {
    display: flex; flex-direction: column; gap: 0.3125rem; align-items: flex-start;
    background: var(--surface); border: 1px solid var(--border-2); border-radius: 8px;
    padding: 0.5rem 0.625rem; min-width: 15rem;
    box-shadow: 0 0.5rem 1.5rem rgba(0, 0, 0, 0.45);
  }
  .kv { color: var(--muted); font: 0.75rem ui-monospace, monospace; margin-top: 0.25rem; }
  .row { display: flex; flex-wrap: wrap; gap: 0.3125rem; align-items: center; margin: 0.125rem 0; }
  .row input, .row textarea {
    background: var(--input-bg); color: var(--text); border: 1px solid var(--border);
    border-radius: 6px; padding: 0.1875rem 0.4375rem; font: 0.75rem ui-monospace, monospace;
  }
  .row textarea { width: 100%; resize: vertical; }
  .row button, .peer { font: 0.75rem ui-monospace, monospace; }
  .chan, .ghost {
    background: var(--surface-2); color: var(--text); border: 1px solid var(--border-2);
    border-radius: 6px; padding: 0.1875rem 0.5rem; cursor: pointer;
  }
  .chan:disabled { background: var(--ok-bg); border-color: var(--ok-border); cursor: default; }
  .chan:hover:not(:disabled), .ghost:hover { background: var(--surface-3); }
  .chan.ink-on { background: var(--ok-bg); border-color: var(--ok-border); color: var(--ok); }
  .thumbs { display: flex; flex-wrap: wrap; gap: 0.375rem; margin-top: 0.375rem; }
  .thumbs img {
    max-width: 6rem; max-height: 4.5rem; border: 1px solid var(--border); border-radius: 6px;
  }
  .peer { color: var(--text-2); margin-top: 0.125rem; }
  .peer .role {
    color: var(--accent); border: 1px solid var(--border); border-radius: 4px;
    padding: 0 0.25rem; margin-right: 0.25rem; font-size: 0.625rem;
  }
  /* Toasts: a FIXED overlay column, bottom-right of the panel — a real
     popup, no reflow. Card = translucent light header over the message. */
  .toasts {
    position: fixed; right: 0.625rem; bottom: 0.625rem; z-index: 60;
    display: flex; flex-direction: column; gap: 0.375rem;
    max-width: min(20rem, calc(100vw - 1.25rem));
  }
  .toast {
    border: 1px solid var(--warn); border-radius: 8px; overflow: hidden;
    background: var(--surface); box-shadow: 0 0.5rem 1.5rem rgba(0, 0, 0, 0.5);
    font: 0.75rem ui-monospace, monospace; color: var(--text);
  }
  .toast-head {
    display: flex; align-items: center; gap: 0.5rem;
    background: rgba(229, 192, 123, 0.22); color: var(--text);
    padding: 0.1875rem 0.5rem; font-size: 0.6875rem; font-weight: 600;
  }
  .toast-count { color: var(--warn); }
  .toast-head .toast-x {
    margin-left: auto; background: none; border: none; color: var(--text-2);
    cursor: pointer; font-size: 0.6875rem; padding: 0;
  }
  .toast-body { padding: 0.375rem 0.5rem; }
  /* The transcript's slot: full panel width (a pane's padding was clipping
     its right edge — found live 2026-07-12). */
  .transcript { margin: 0 0.125rem 0.625rem; }
  /* The embedded trace debugger. Its layout is a flex COLUMN (compact picker,
     then the trace's two collapsible sections, each scrolling) — it needs a
     DEFINITE height or the flex children collapse to zero (found live
     2026-07-12). */
  .trace-host { width: 100%; }
  .trace-host .aiui-dbgt { height: 32rem; max-height: 75vh; overflow: hidden; }
  .leader {
    font: 0.6875rem ui-monospace, monospace; color: var(--text-2);
    border: 1px solid var(--border-2); background: var(--surface-2); border-radius: 6px;
    padding: 0.25rem 0.5rem; margin: 0 0.125rem 0.625rem;
  }
`;

function Panel() {
  const [windowId, setWindowId] = createSignal<number | undefined>();
  const [rev, setRev] = createSignal(0);
  const [loweredPrompt, setLoweredPrompt] = createSignal<string | undefined>();

  const session = createSession();

  // ── the /tools link: tab-activation reporting, tied to the binding ────────
  // Solid 2.0 createEffect(compute, effect): the compute tracks (port,
  // windowId); the effect rewires the link when either changes and returns its
  // teardown, which runs before the next rewire and on panel dispose. (A
  // one-arg createEffect throws MISSING_EFFECT_FN at runtime in Solid 2.0.)
  createEffect(
    () => ({ port: session.port(), win: windowId() }),
    ({ port, win }) => {
      if (port === undefined || win === undefined) {
        return;
      }
      const link = connectToolsLink({ port, windowId: win });
      return () => link.close();
    },
  );

  // ── the engine: one per panel document ────────────────────────────────────
  const engine = new Engine(panelIntentConfig());
  const mirror = turnMirror(windowId);
  // PULL selection model (decided 2026-07-11): nothing enters the turn until
  // the user's explicit "add selection", which opens the turn itself when none
  // is open (engine.appSelection arms-gated thread opening). No staging.
  const [selectionPresent, setSelectionPresentSignal] = createSignal(false);
  // Mirrored for the same reason as inkOnNow: the caps re-render from a plain
  // read right after this changes (the 📋 cap stayed lit after a deselect).
  let selectionPresentNow = false;
  const setSelectionPresent = (present: boolean): void => {
    selectionPresentNow = present;
    setSelectionPresentSignal(present);
  };

  /** The active tab's identity, for the hello's context block. */
  const activeTabMeta = async (): Promise<Record<string, unknown> | undefined> => {
    const win = windowId();
    if (win === undefined) {
      return undefined;
    }
    const [tab] = await chrome.tabs.query({ active: true, windowId: win });
    return tab === undefined
      ? undefined
      : {
          ...(tab.url !== undefined ? { url: tab.url } : {}),
          ...(tab.title !== undefined ? { title: tab.title } : {}),
          ...(tab.id !== undefined ? { chromeTabId: tab.id } : {}),
          windowId: win,
          tabIndex: tab.index,
        };
  };

  // ── the wire: the overlay's shared shell, panel-hosted (Phase C1) ─────────
  // createWire owns batching, attachment discipline, bad-ack surfacing,
  // finalize/cancel, and lowered-echo merging (which C5 talk requires); the
  // panel provides only the host seams — openThread over the bound port with
  // tab-identity meta, errors → toasts, status → the console channel.
  const wire = createWire({
    engine,
    config: () => engine.settings,
    openThread: async (options) => {
      const port = session.port();
      if (port === undefined) {
        // No toast here: boot-time turn recovery may replay before the
        // auto-bind lands, and send-time surfacing is the wire's own job
        // ("composed locally…" + its connection toast).
        throw new Error("no channel bound");
      }
      const tab = await activeTabMeta();
      return openIntentThread({
        url: `ws://127.0.0.1:${port}/ws`,
        format: "intent-v1",
        meta: {
          ...(tab !== undefined ? { tab } : {}),
          actor: "human",
          ...(options.intent !== undefined ? { intent: options.intent } : {}),
        } as never,
        onSocket: (socket) => {
          // Connection-level pushes: error surfacing (the overlay host's
          // rule) plus the lowered-prompt echo the panel displays.
          socket.onServerMessage((msg) => {
            if (isErrorMessage(msg)) {
              toast(`${msg.source ?? "channel"}: ${msg.message}`);
            } else if (msg.kind === "lowered-prompt" && typeof msg.prompt === "string") {
              setLoweredPrompt(msg.prompt);
              logInfo("turn sent — lowered prompt received");
            }
          });
        },
      });
    },
    setStatus: (text) => logInfo("wire:", text),
    reportError: (error) => toast(`${error.source ?? "channel"}: ${error.message}`),
    clearSelection: () => {}, // pull model: selections are engine events, no chip to consume
    enqueueSpeech: () => {}, // server speech clips arrive with C5 (talk)
  });

  // ── capture state: shots + per-tab ink (step 5) ────────────────────────────
  // The standing ink-mode flag lives in the store (durableSignal — §13.6
  // standing state, survives panel hot swaps), MIRRORED into a plain variable:
  // Solid defers writes, so `set(x)` followed by a read in the same flow gives
  // the STALE value — and the machine reads it immediately (the pointer claim,
  // the ✏️ cap). That inverted both (found live 2026-07-12; same trap as
  // `phaseNow`). Rule: never read a signal to decide something in the flow
  // that wrote it.
  let inkOnNow = inkMode.get();
  const inkOn = (): boolean => inkOnNow;
  const setInkOn = (on: boolean): void => {
    inkOnNow = on;
    inkMode.set(on);
  };
  /** The tab whose content script holds the ink surface, while ink is on. */
  let inkTabId: number | undefined;
  /** Strokes since the last clear — gates the ink-clear events (no ink, no event). */
  let strokesSinceClear = 0;
  /** The window's active tab as last seen — the `from` side of a tab boundary. */
  let lastActiveTab: { id: number; url?: string } | undefined;

  /**
   * The ink POINTER claim, DERIVED — never toggled ad hoc. It is on iff a turn
   * is open AND ink mode is on: tweak hands the page back BOTH keyboard and
   * pointer (found live 2026-07-12 — ink kept drawing in tweak), and resuming
   * re-claims it. The mode FLAG and the strokes are untouched (standing
   * state, §13.6). Resolved against the LIVE active tab, so a tab switch or a
   * stale id can't strand the claim.
   */
  const syncInkPointer = async (): Promise<void> => {
    const want = phaseNow === "turn" && inkOn();
    const tabId = await activeTabId();
    if (inkTabId !== undefined && (!want || inkTabId !== tabId)) {
      await relayRequestTab(inkTabId, "page", "ink", { on: false }).catch(() => {});
      if (!want) {
        return;
      }
    }
    if (!want || tabId === undefined) {
      return;
    }
    inkTabId = tabId;
    await relayRequestTab(tabId, "page", "ink", { on: true, fadeSec: inkFade.get() }).catch(
      () => {},
    );
  };

  /**
   * Erase the strokes and record why — `manual` is the user's clear (the C
   * key / pane button), `silent` a disarm (abandon everything; nothing may
   * land after). §13.6: these are the ONLY clears — never turn end, mode
   * exit, resize, or tab switch. Off-mode, the tab's empty surface unmounts
   * and the tab is released.
   */
  const inkClear = async (why: "manual" | "silent"): Promise<void> => {
    const tabId = inkTabId;
    const hadStrokes = strokesSinceClear > 0;
    strokesSinceClear = 0;
    if (!inkOn()) {
      inkTabId = undefined;
    }
    if (tabId !== undefined) {
      await relayRequestTab(tabId, "page", "ink", { clear: true }).catch(() => {});
    }
    if (hadStrokes && engine.threadOpen && why === "manual") {
      engine.inkCleared(false);
    }
  };

  /**
   * The ink MODE toggle. The flag is standing state (§13.6 — it outlives
   * turns); the POINTER claim it implies is DERIVED (syncInkPointer), so a
   * toggle outside a turn just arms the flag and the next turn entry claims.
   */
  const toggleInkMode = (): void => {
    setInkOn(!inkOn());
    void syncInkPointer();
    syncIslands(); // the ✏️ cap follows the flag
    logInfo(inkOn() ? "ink mode on" : "ink mode off (strokes stay)");
  };

  /**
   * One whole-viewport shot of the active tab. Dims come from the page itself
   * (CSS px + dpr) so the SW/offscreen capture can pin the track to the tab's
   * native size — unconstrained tab tracks default to display-sized
   * crop-and-scale (measured). The engine event carries the thumb; the PNG
   * bytes ride the thread socket as an `attachment` chunk keyed by the shot's
   * marker, exactly the overlay wire's shape.
   */
  const takeShot = async (): Promise<void> => {
    const win = windowId();
    if (win === undefined) {
      return;
    }
    const [tab] = await chrome.tabs.query({ active: true, windowId: win });
    if (tab?.id === undefined) {
      toast("a shot needs an active tab");
      return;
    }
    const takenAt = Date.now();
    let vp: { w: number; h: number; dpr: number };
    try {
      vp = await relayRequestTab<{ w: number; h: number; dpr: number }>(tab.id, "page", "viewport");
    } catch {
      // No content script (chrome:// etc.) — tab metrics are CSS px; capture
      // itself will usually refuse such pages with the invocation error.
      vp = { w: tab.width ?? 1280, h: tab.height ?? 800, dpr: 1 };
    }
    logDebug("capturing…");
    try {
      const grab = await relayRequest<ShotGrab>("sw", "capture", {
        tabId: tab.id,
        width: vp.w,
        height: vp.h,
        dpr: vp.dpr,
      });
      // Camera-style confirmation, strictly AFTER the grab returned so the
      // wash can never be in the frame it confirms. (A same-second burst
      // could still catch the tail of the previous flash — 240ms, accepted.)
      // §13.6: manual shots flash (the shotFlash control is the easy off);
      // share-sampled frames (Phase C) never will.
      if (shotFlash.get()) {
        void relayRequestTab(tab.id, "page", "flash", { kind: "shot" }).catch(() => {});
      }
      const marker = engine.shotDone(
        { x: 0, y: 0, w: vp.w, h: vp.h },
        [],
        grab.thumb,
        undefined,
        true,
        takenAt,
      );
      await wire.uploadAttachment(marker, "image/png", dataUrlToBytes(grab.png));
      logInfo(`${marker} captured (${grab.width}×${grab.height})`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // The invocation gate is THE sanctioned toast case (misuse feedback);
      // toasts dedupe with ×N, so repeats visibly change.
      toast(
        isNotInvokedError(message)
          ? "tab not invoked: press ⌘B twice (cancel + reopen the turn invokes THIS tab) " +
              "or click the aiui toolbar button, then retry"
          : `shot failed: ${message}`,
      );
    }
  };

  // Ring broadcast to this window's tabs (§13.6: the ring is the page's ONLY
  // evidence — armed = steady, in-turn = breathing). Also runs at boot: a
  // reopened panel starts disarmed, and without the boot sync a ring lit by
  // the previous panel document would stay lit forever (found live).
  const broadcastRing = (): void => {
    // The islands re-assert from the same transitions the ring does (they are
    // imperative — no reactive subscription; see preview-pane's module note).
    syncIslands();
    const win = windowId();
    const on = phaseNow !== "disarmed";
    const composing = phaseNow === "turn" || phaseNow === "tweak";
    if (win !== undefined) {
      void chrome.tabs.query({ windowId: win }).then((tabs) => {
        for (const tab of tabs) {
          if (tab.id !== undefined) {
            chrome.tabs
              .sendMessage(tab.id, { aiuiRing: 1, armed: on && !composing, turn: composing })
              .catch(() => {});
          }
        }
      });
    }
  };
  engine.onEvent((event, eng) => {
    setRev((r) => r + 1);
    syncIslands();
    // The shared wire sees every event (thread-open opens its socket, the
    // rest batch on its debounce), then the close verbs — the overlay
    // modality's exact composition (wire.ts is the shared shell).
    wire.onEngineEvent(event);
    if (event.type === "thread-close") {
      if (event.reason === "send") {
        void wire.finalizeThread();
      } else {
        void wire.cancelThread();
      }
      // An engine-side close must land the phase back at "armed" — §13.6:
      // turn ends, you STAY armed (send uses keepArmed now — the re-arm
      // bridge is gone), no new turn auto-begins. Ink strokes untouched
      // (divergence 5 clears them only on disarm).
      if (phaseNow === "turn" || phaseNow === "tweak") {
        leavePhaseTurn("armed");
      }
    }
    mirror.persist(currentThreadEvents(eng.events), eng.threadOpen);
  });

  // ── broadcasts up from this window's content scripts ──────────────────────
  // Selection presence (affordance only — payloads travel on request), plus
  // ink facts from the inked tab: completed strokes → engine.strokeDone, and
  // the fade's auto-clear → engine.inkCleared.
  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (msg === null || typeof msg !== "object" || sender.tab?.windowId !== windowId()) {
      return false;
    }
    const m = msg as {
      aiuiSelectionPresence?: number;
      present?: boolean;
      aiuiStroke?: number;
      points?: number;
      bounds?: Rect;
      aiuiInkClear?: number;
    };
    if (m.aiuiSelectionPresence === 1) {
      setSelectionPresent(m.present === true);
      syncIslands(); // the 📋 cap follows the page's selection live
    }
    if (
      m.aiuiStroke === 1 &&
      sender.tab?.id === inkTabId &&
      typeof m.points === "number" &&
      m.bounds !== undefined
    ) {
      strokesSinceClear += 1;
      // ⚠ Phase-B bridge: engine.strokeDone would implicitly OPEN a thread,
      // and §13.6 says only ⌘B opens turns — so strokes reach the engine
      // only while a turn is open. Between turns, drawing is page-whiteboard
      // only (the strokes still land in later shots as page content).
      if (phaseNow === "turn" || phaseNow === "tweak") {
        engine.strokeDone(m.points, m.bounds);
      }
    }
    if (m.aiuiInkClear === 1 && sender.tab?.id === inkTabId) {
      strokesSinceClear = 0;
      if (engine.threadOpen) {
        engine.inkCleared(true);
      }
      if (!inkOn()) {
        inkTabId = undefined; // faded away after mode exit — tab released
      }
    }
    return false;
  });

  // ── tab provenance: activation is a context boundary (proposal §2) ─────────
  // On an open turn, a tab switch within this window emits `navigation` with
  // the two tabs' URLs — ordering in the log attributes everything before it
  // to `from`. §13.6: strokes are PER-TAB page state — a switch clears
  // nothing (each tab keeps its own document-anchored ink); the in-turn
  // captures simply re-point at the newly active tab.
  chrome.tabs.onActivated.addListener((info) => {
    void (async () => {
      if (info.windowId !== windowId()) {
        return;
      }
      const prev = lastActiveTab;
      let toUrl: string | undefined;
      try {
        toUrl = (await chrome.tabs.get(info.tabId)).url;
      } catch {
        // tab already gone — the boundary still happened
      }
      lastActiveTab = { id: info.tabId, url: toUrl };
      if (prev === undefined || prev.id === info.tabId) {
        return;
      }
      // `from` re-read at boundary time: the tab may have navigated since it
      // was last active, and the boundary should name where the user LEFT.
      let fromUrl = prev.url;
      try {
        fromUrl = (await chrome.tabs.get(prev.id)).url ?? fromUrl;
      } catch {
        // closed tabs keep their last-seen url
      }
      if (engine.threadOpen) {
        engine.navigation(fromUrl ?? "", toUrl ?? "");
      }
      if (phaseNow === "turn") {
        pointCaptureAt(info.tabId);
        // The ink POINTER follows the active tab while the mode is on; the
        // old tab keeps its strokes (deactivated surface, page state).
        if (inkOn()) {
          if (inkTabId !== undefined && inkTabId !== info.tabId) {
            void relayRequestTab(inkTabId, "page", "ink", { on: false }).catch(() => {});
          }
          inkTabId = info.tabId;
          void relayRequestTab(info.tabId, "page", "ink", {
            on: true,
            fadeSec: inkFade.get(),
          }).catch(() => {});
        }
      }
    })();
  });

  // The slurp: pull the active tab's current selection and add it to the turn
  // right now (or stage it as the turn's opener when no thread is open yet).
  const addSelection = async (): Promise<void> => {
    const win = windowId();
    if (win === undefined) {
      return;
    }
    const [tab] = await chrome.tabs.query({ active: true, windowId: win });
    if (tab?.id === undefined) {
      toast("adding a selection needs an active tab");
      return;
    }
    try {
      const payload = await relayRequestTab<AppSelection | null>(tab.id, "page", "selection");
      if (payload === null) {
        // Misuse-shaped but tiny: the miss flash says "nothing to add".
        void relayRequestTab(tab.id, "page", "flash", { kind: "miss" }).catch(() => {});
        logInfo("add selection: nothing selected on the page");
        return;
      }
      engine.appSelection(payload);
      logInfo("selection added to the turn");
    } catch (err) {
      toast(
        `selection pull failed (reload the tab?): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  // ── the §13.6 state machine (grammar in leader.ts; spec in the proposal) ──
  // disarmed ⊂ armed ⊂ in-a-turn (+ tweak excursion). Armed is presence —
  // border only, everything passes through. Capture is per-TURN: keyboard
  // while a turn is open (+ pointer when ink mode is on). ⌘B is the ONLY
  // turn-opener; Esc is the in-turn cancel rung; T releases capture with the
  // turn open and only ⌘B can resume (the page owns every ordinary key in
  // tweak). Send/cancel keep you armed. Disarm abandons everything.
  // The machine's truth is a PLAIN variable, mirrored into a signal for the
  // UI. Solid 2.0 defers signal writes — phase() read right after setPhase()
  // returns the STALE value, which (found live 2026-07-12) broadcast the
  // previous state's ring and let a synchronous engine event stomp a disarm
  // back to armed. All machine logic reads `phaseNow`; only JSX reads the
  // signal.
  type Phase = "disarmed" | "armed" | "turn" | "tweak";
  let phaseNow: Phase = "disarmed";
  const [phase, setPhaseSignal] = createSignal<Phase>("disarmed");
  const setPhase = (p: Phase): void => {
    phaseNow = p;
    setPhaseSignal(p);
  };
  /** The rejected key currently blipping (`× g`), if any. A plain variable:
   * only the imperative caps island reads it, synchronously (a signal here
   * fired Solid's STRICT_READ_UNTRACKED and could serve a stale value). */
  let blipNow: string | undefined;
  const setBlip = (key: string | undefined): void => {
    blipNow = key;
  };
  let blipTimer: number | undefined;
  /** The tab whose content script holds the key capture, while in-turn. */
  let leaderTabId: number | undefined;

  const leaderState = (): LeaderState => ({
    phase: phaseNow === "disarmed" ? "armed" : (phaseNow as "armed" | "turn" | "tweak"),
    inkOn: inkOnNow,
    selectionPresent: selectionPresentNow,
  });

  // ── the shared imperative islands (the overlay's Preview + CheatSheet +
  // KeymapHelp). Solid 2.0 rule, learned live: they own internal signals, so
  // BUILDING or UPDATING them inside an owned scope (component body, effect)
  // throws [REACTIVE_WRITE_IN_OWNED_SCOPE] — `help.render()` writes on
  // construction. Build them in a microtask (outside the owner) and drive
  // them only from plain callbacks: phase transitions and engine events.
  let previewIsland: PreviewIsland | undefined;
  let keysIsland: KeysIsland | undefined;
  let previewHost: HTMLElement | undefined;
  let keysBarHost: HTMLElement | undefined;
  let keysPopupHost: HTMLElement | undefined;
  let helpOpen = false;

  /** Re-assert both islands from the CURRENT state. Plain callbacks only. */
  const syncIslands = (): void => {
    previewIsland?.sync(phaseNow === "turn" || phaseNow === "tweak");
    keysIsland?.sync(leaderState(), helpOpen, blipNow);
  };

  queueMicrotask(() => {
    previewIsland = createPreviewIsland(engine);
    keysIsland = createKeysIsland(
      (key) => applyLeaderKey(key, "down", false),
      () => {
        helpOpen = false;
        syncIslands();
      },
    );
    previewHost?.append(previewIsland.root);
    keysBarHost?.append(keysIsland.barRoot);
    keysPopupHost?.append(keysIsland.popupRoot);
    syncIslands();
  });

  /** Point the page-side key capture at a tab (or nowhere). */
  const pointCaptureAt = (tabId: number | undefined): void => {
    const prev = leaderTabId;
    leaderTabId = tabId;
    if (prev !== undefined && prev !== tabId) {
      void relayRequestTab(prev, "page", "keylayer", { on: false }).catch(() => {});
    }
    if (tabId !== undefined) {
      // chrome:// pages have no content script — keys then work only with
      // the panel focused; the hint strip is panel-only anyway (§13.6).
      void relayRequestTab(tabId, "page", "keylayer", { on: true }).catch(() => {});
    }
  };

  /** The active tab id, or undefined (no tab / no window yet). */
  const activeTabId = async (): Promise<number | undefined> => {
    const win = windowId();
    if (win === undefined) {
      return undefined;
    }
    const [tab] = await chrome.tabs.query({ active: true, windowId: win });
    return tab?.id;
  };

  /**
   * Leave the in-turn phase for `to` ("armed" after send/cancel, "tweak" for
   * the excursion): release the keyboard capture and the ink POINTER (the
   * mode flag and the strokes persist — standing state, §13.6). Never touches
   * the engine; callers own the engine verbs.
   */
  const leavePhaseTurn = (to: "armed" | "tweak"): void => {
    setPhase(to);
    setBlip(undefined);
    helpOpen = false;
    pointCaptureAt(undefined);
    if (inkTabId !== undefined) {
      void relayRequestTab(inkTabId, "page", "ink", { on: false }).catch(() => {});
    }
    broadcastRing();
  };

  /** Enter the in-turn phase (⌘B open or tweak-resume): capture on. */
  const enterPhaseTurn = async (): Promise<void> => {
    setPhase("turn");
    // §13.6 divergence 1, now engine-real (C1): the thread opens HERE,
    // explicitly — no-op on tweak-resume (already open). The wire's socket
    // opens on the resulting thread-open event.
    engine.openTurn();
    broadcastRing();
    const tabId = await activeTabId();
    if (tabId !== undefined && phaseNow === "turn") {
      pointCaptureAt(tabId);
      // Re-apply the standing ink-mode flag: the pointer claim is per-turn.
      if (inkOn()) {
        inkTabId = tabId;
        void relayRequestTab(tabId, "page", "ink", {
          on: true,
          fadeSec: inkFade.get(),
        }).catch(() => {});
      }
    }
  };

  /** The open turn holds something worth lowering (explicit turns can be empty). */
  const turnHasContent = (): boolean =>
    composeIntent(currentThreadEvents(engine.events)).items.length > 0;

  /** End the open turn: `send` lowers it, `cancel` drops it. STAY ARMED. */
  const endTurn = (how: "send" | "cancel"): void => {
    if (how === "send" && engine.threadOpen) {
      if (turnHasContent()) {
        engine.send({ keepArmed: true }); // §13.6: the next ⌘B starts the next turn
      } else {
        engine.stepOut(); // an empty explicit turn: nothing to lower — cancel
        logInfo("nothing in the turn — cancelled");
      }
    } else if (engine.threadOpen) {
      engine.stepOut(); // in-thread: closes with reason "cancel", stays armed
    }
    if (phaseNow === "turn" || phaseNow === "tweak") {
      leavePhaseTurn("armed");
    }
  };

  /**
   * Arming (pill or ⌘B) requires a bound channel — a turn with nowhere to go
   * is a misunderstanding, which is the toast channel's job. NOTE: a bound
   * port that is merely RECONNECTING stays bound (resilience — outages never
   * disarm); only truly unbound blocks.
   */
  const requireChannel = (): boolean => {
    if (session.port() === undefined) {
      toast("no channel bound — pick one from the connection chip");
      return false;
    }
    return true;
  };

  /**
   * Arm WITHOUT opening a turn — the header pill's cold-start click (§13.6:
   * armed is presence; ⌘B remains the only turn-opener).
   */
  const armOnly = (): void => {
    if (!requireChannel()) {
      return;
    }
    engine.setArmed(true);
    setPhase("armed");
    broadcastRing();
    logInfo("armed — ⌘B starts a turn");
  };

  /** Disarm: abandon EVERYTHING (§13.6) — turn, ink, standing tools, ring. */
  const disarm = (): void => {
    setPhase("disarmed"); // first — the armed(false) bridge checks this
    pointCaptureAt(undefined);
    setBlip(undefined);
    if (engine.threadOpen) {
      engine.stepOut();
    }
    engine.setArmed(false);
    setInkOn(false);
    void inkClear("silent");
    // Standing tools (hands-free, share) tear down here when they land
    // (Phase C) — the §13.6 contract is recorded now.
    broadcastRing();
    logInfo("disarmed — everything abandoned");
  };

  /**
   * The leader (⌘B) — the state-dependent verb of §13.6's table:
   * disarmed → arm + open a turn · armed → open a turn · in-turn → step out
   * (cancel the turn) · tweak → RESUME the same turn.
   */
  const leaderPress = async (): Promise<void> => {
    switch (phaseNow) {
      case "disarmed":
        if (!requireChannel()) {
          return;
        }
        engine.setArmed(true);
        await enterPhaseTurn();
        logInfo("turn open");
        return;
      case "armed":
        if (!requireChannel()) {
          return;
        }
        await enterPhaseTurn();
        logInfo("turn open");
        return;
      case "turn":
        endTurn("cancel");
        logInfo("turn cancelled — still armed");
        return;
      case "tweak":
        await enterPhaseTurn();
        logInfo("turn resumed");
        return;
    }
  };

  const leaderDispatch = (action: LeaderAction): void => {
    if (action === "help") {
      helpOpen = !helpOpen;
      syncIslands();
      return;
    }
    if (action === "disarm") {
      disarm();
      return;
    }
    if (action === "send") {
      endTurn("send");
      return;
    }
    if (action === "cancel") {
      endTurn("cancel");
      logInfo("turn cancelled — still armed");
      return;
    }
    if (action === "tweak") {
      leavePhaseTurn("tweak");
      logInfo("tweak — the page has keyboard and pointer; ⌘B resumes");
      return;
    }
    if (session.port() === undefined) {
      toast("no channel bound — pick one from the connection chip");
      return;
    }
    if (action === "ink") {
      toggleInkMode();
    } else if (action === "clear") {
      void inkClear("manual");
    } else if (action === "shot") {
      void takeShot();
    } else if (action === "selection") {
      void addSelection();
    }
  };

  /** The `× key` feedback for a swallowed typo — panel strip + page flash. */
  const blipKey = (key: string): void => {
    setBlip(key);
    if (blipTimer !== undefined) {
      clearTimeout(blipTimer);
    }
    blipTimer = window.setTimeout(() => {
      setBlip(undefined);
      syncIslands();
    }, LEADER_BLIP_MS);
    syncIslands();
    if (leaderTabId !== undefined) {
      void relayRequestTab(leaderTabId, "page", "flash", { kind: "miss" }).catch(() => {});
    }
  };

  const applyLeaderKey = (
    key: string,
    keyPhase: "down" | "up",
    repeat: boolean,
  ): "handled" | "pass" => {
    const verdict = leaderKeyEvent(leaderState(), key, keyPhase, repeat);
    if (verdict.kind === "pass") {
      return "pass";
    }
    if (verdict.kind === "action") {
      // The keys popup is a LAYER: Esc dismisses it before the turn's rung.
      if (verdict.action === "cancel" && helpOpen) {
        helpOpen = false;
        syncIslands();
        return "handled";
      }
      leaderDispatch(verdict.action);
    } else if (verdict.kind === "ignored") {
      blipKey(verdict.key);
    }
    return "handled";
  };

  // ── panel zoom: ⌘+/⌘−/⌘0 (browser zoom does not reach side panels) ────────
  // Multiplies the browser's accessibility font-size default via a percentage
  // root font-size (all panel sizes are rem — see index.html). Registered
  // BEFORE the leader key listener so the chords win even mid-turn; persisted
  // across panel reopens in chrome.storage.local. The uiScale control's own
  // bounds clamp every step.
  const UI_SCALE_KEY = "panel.uiScale";
  const applyUiScale = (scale: number): void => {
    document.documentElement.style.fontSize = `${Math.round(scale * 100)}%`;
  };
  void chrome.storage.local
    .get(UI_SCALE_KEY)
    .then((got) => {
      const saved = got[UI_SCALE_KEY];
      // Solid BATCHES writes: `set()` then `get()` in the same tick reads the
      // STALE value — the original restore did exactly that and silently
      // applied 100% while storage held the real scale (found live
      // 2026-07-12). Use what `set()` returns: the actually-written, clamped
      // value. (zoomStep always did; only the restore was wrong.)
      applyUiScale(typeof saved === "number" ? uiScale.set(saved) : uiScale.get());
    })
    .catch(() => applyUiScale(uiScale.get()));
  const zoomStep = (delta: number): void => {
    // Float-safe stepping (0.1 increments live in binary-float land).
    const next = delta === 0 ? 1 : Math.round((uiScale.get() + delta) * 10) / 10;
    const applied = uiScale.set(next); // clamped by the control's bounds
    applyUiScale(applied);
    void chrome.storage.local.set({ [UI_SCALE_KEY]: applied });
  };
  document.addEventListener(
    "keydown",
    (event) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) {
        return;
      }
      const delta =
        event.key === "+" || event.key === "=" ? 0.1 : event.key === "-" ? -0.1 : undefined;
      if (delta !== undefined || event.key === "0") {
        event.preventDefault();
        event.stopImmediatePropagation(); // never reaches the turn grammar
        zoomStep(delta ?? 0);
      }
    },
    true,
  );

  // The panel document's own key capture (focus may sit here, especially
  // right after the SW opens the panel). Yields to the panel's OWN form
  // fields — tool UI, not the website; the wholesale claim is per-turn and
  // on the page. Lives as long as the panel document.
  const onPanelKey = (keyPhase: "down" | "up") => (event: KeyboardEvent) => {
    if (isTypingTarget(event)) {
      return;
    }
    if (applyLeaderKey(event.key, keyPhase, event.repeat) === "handled") {
      event.preventDefault();
      event.stopPropagation();
    }
  };
  document.addEventListener("keydown", onPanelKey("down"), true);
  document.addEventListener("keyup", onPanelKey("up"), true);

  // Leader broadcasts: the SW's press notification carries no sender.tab (it
  // is not a content script), so this is its own listener, not a branch of
  // the tab-filtered one above.
  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (msg === null || typeof msg !== "object") {
      return false;
    }
    const m = msg as {
      aiuiLeader?: number;
      windowId?: number;
      aiuiLeaderKey?: number;
      key?: string;
      aiuiPageHello?: number;
    };
    if (m.aiuiLeader === 1 && m.windowId === windowId()) {
      void leaderPress();
    }
    if (m.aiuiLeaderKey === 1 && sender.tab?.windowId === windowId() && typeof m.key === "string") {
      applyLeaderKey(m.key, "down", false);
    }
    // A fresh content script's state pull (navigation, new tab, HMR swap):
    // answer with the ring state, and re-point the in-turn key capture if the
    // hello came from the window's active tab. Without this, state silently
    // died at every navigation (found live 2026-07-11 — the back button
    // "fixing" it was bfcache resurrecting old listeners).
    const helloTab = sender.tab;
    if (
      m.aiuiPageHello === 1 &&
      helloTab !== undefined &&
      helloTab.windowId === windowId() &&
      helloTab.id !== undefined
    ) {
      const composing = phaseNow === "turn" || phaseNow === "tweak";
      chrome.tabs
        .sendMessage(helloTab.id, {
          aiuiRing: 1,
          armed: phaseNow !== "disarmed" && !composing,
          turn: composing,
        })
        .catch(() => {});
      if (phaseNow === "turn" && helloTab.active) {
        pointCaptureAt(helloTab.id);
      }
    }
    return false;
  });

  // ── boot: window id, ring sync, then turn recovery from the mirror ────────
  void chrome.windows.getCurrent().then(async (w) => {
    setWindowId(w.id);
    broadcastRing(); // fresh panel = disarmed; kill any stale ring
    if (w.id !== undefined) {
      const [tab] = await chrome.tabs.query({ active: true, windowId: w.id });
      if (tab?.id !== undefined) {
        lastActiveTab = { id: tab.id, ...(tab.url !== undefined ? { url: tab.url } : {}) };
      }
    }
    // Recovery first, pending leader second: a recovered turn re-enters the
    // in-turn phase, and a parked ⌘B then means its ladder step, not a
    // surprise second turn. Give the session's auto-bind a short settle
    // first — the replay re-streams to a fresh socket (overlay parity), and
    // that socket needs the port.
    const recovered = await mirror.recover();
    if (recovered !== undefined && session.port() === undefined) {
      for (let i = 0; i < 15 && session.port() === undefined; i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    if (recovered !== undefined) {
      engine.replay(recovered.events, { threadOpen: recovered.threadOpen });
      if (recovered.threadOpen) {
        await enterPhaseTurn();
      } else {
        setPhase("armed"); // replay forces engine.armed = true
        broadcastRing();
      }
      logInfo(`recovered an in-progress turn (${recovered.events.length} events)`);
    }
    // A leader press may have opened this panel — consume the parked press
    // (missed broadcasts are the rule during boot) if it is fresh enough to
    // still be what the user means.
    if (w.id !== undefined) {
      const pending = await relayRequest<PendingLeader | null>("sw", "leaderPending", {
        windowId: w.id,
      }).catch(() => null);
      if (leaderPendingFresh(pending, Date.now())) {
        void leaderPress();
      }
    }
  });

  // Live fade: the inkFade control moving while ink is on re-relays the new
  // lifetime to the inked tab (the content surface reads it per frame).
  createEffect(
    () => ({ fade: inkFade.get() }),
    ({ fade }) => {
      if (inkOn() && inkTabId !== undefined && phaseNow === "turn") {
        void relayRequestTab(inkTabId, "page", "ink", { on: true, fadeSec: fade }).catch(() => {});
      }
    },
  );

  return (
    <>
      <style>{PANEL_STYLES}</style>
      <div class="hdr">
        <span class="mark">✳ aiui</span>
        <ConnectionChip session={session} />
        <button
          type="button"
          class={phase() !== "disarmed" ? "pill on" : "pill"}
          disabled={phase() === "disarmed" && session.port() === undefined}
          title="armed = presence (border only); needs a bound channel. Off-click disarms: abandons turn, ink, standing tools (§13.6)"
          onClick={() => (phaseNow === "disarmed" ? armOnly() : disarm())}
        >
          <span class="dot" />
          armed
        </button>
        <button
          type="button"
          class={phase() === "turn" || phase() === "tweak" ? "pill turn on" : "pill turn"}
          disabled={phase() === "disarmed"}
          title="the open turn (⌘B). Off-click cancels it — you stay armed"
          onClick={() => {
            if (phaseNow === "armed") {
              if (!requireChannel()) {
                return;
              }
              void enterPhaseTurn();
              logInfo("turn open");
            } else if (phaseNow === "turn" || phaseNow === "tweak") {
              endTurn("cancel");
              logInfo("turn cancelled — still armed");
            }
          }}
        >
          <span class="dot" />
          turn
        </button>
        <span class="win">win {windowId() ?? "?"}</span>
      </div>
      <Toasts />
      {phase() === "tweak" ? <div class="leader">🔧 tweak — ⌘B resumes the turn</div> : null}
      {/* The command bar: the live keycaps, visible whenever a turn is open. */}
      <div
        ref={(el: HTMLDivElement) => {
          keysBarHost = el;
          if (keysIsland !== undefined) {
            el.append(keysIsland.barRoot);
          }
        }}
      />
      {/* The transcript lives directly under the command bar — permanently
          visible, not a pane tenant (the Turn pane is a temporary helper and
          will retire into the command bar). */}
      <div
        class="transcript"
        ref={(el: HTMLDivElement) => {
          previewHost = el;
          if (previewIsland !== undefined) {
            el.append(previewIsland.root);
          }
        }}
      />
      {/* The keys popup (?): a fixed, dismissible overlay. */}
      <div
        ref={(el: HTMLDivElement) => {
          keysPopupHost = el;
          if (keysIsland !== undefined) {
            el.append(keysIsland.popupRoot);
          }
        }}
      />
      <PaneStack>
        <TurnPane
          engine={engine}
          rev={rev}
          canCompose={() => phaseNow === "turn"}
          onNoTurn={() => toast("no turn open — ⌘B starts one")}
          onSend={() => endTurn("send")}
          onCancel={() => {
            endTurn("cancel");
            logInfo("turn cancelled — still armed");
          }}
          loweredPrompt={loweredPrompt}
          onAddSelection={() => void addSelection()}
          selectionPresent={selectionPresent}
        />
        <TracePane session={session} />
        <Pane title="Dev" defaultOpen={false} hint="probes">
          <CellView of={graph().swPing} label="pinging the service worker">
            {(r) => <div class="kv">service worker alive ({r().at.slice(11, 19)})</div>}
          </CellView>
        </Pane>
      </PaneStack>
    </>
  );
}

injectPaneStyles();
const root = document.getElementById("root");
if (root) {
  render(() => <Panel />, root);
}
