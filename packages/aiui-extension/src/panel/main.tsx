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
  Engine,
  type Rect,
} from "@habemus-papadum/aiui-dev-overlay/intent-pipeline";
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
import { CapturePane } from "./capture-pane";
import {
  LEADER_BLIP_MS,
  type LeaderAction,
  type LeaderState,
  leaderHintText,
  leaderKeyEvent,
  leaderPendingFresh,
  type PendingLeader,
} from "./leader";
import { SessionPane } from "./session-pane";
import { connectToolsLink } from "./tools-link";
import { attachTurnHost, panelIntentConfig, turnMirror } from "./turn";
import { TurnPane } from "./turn-pane";

const PANEL_STYLES = `
  .hdr { display: flex; align-items: center; gap: 8px; margin: 2px 2px 10px; }
  .hdr .mark { color: #8ab4f8; font-weight: 700; }
  .hdr .win { margin-left: auto; color: #9aa4bd; font: 11px ui-monospace, monospace; }
  .arm {
    font: 11px ui-monospace, monospace; border-radius: 999px; padding: 2px 10px;
    border: 1px solid #3a4460; background: #232a3a; color: #cfd6e4; cursor: pointer;
  }
  .arm.on { background: #1d3a2a; border-color: #2f6b45; color: #7bd88f; }
  .chip {
    display: inline-flex; align-items: center; gap: 5px;
    font: 11px ui-monospace, monospace; color: #cfd6e4;
    border: 1px solid #2a3140; border-radius: 999px; padding: 2px 8px;
  }
  .chip .dot { width: 7px; height: 7px; border-radius: 50%; background: #4a5468; }
  .chip.on .dot { background: #7bd88f; }
  .chip.connecting .dot { background: #e5c07b; }
  .kv { color: #9aa4bd; font: 12px ui-monospace, monospace; margin-top: 4px; }
  .row { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; margin: 2px 0; }
  .row input, .row textarea {
    background: #0d0f15; color: #dfe3ec; border: 1px solid #2a3140;
    border-radius: 6px; padding: 3px 7px; font: 12px ui-monospace, monospace;
  }
  .row textarea { width: 100%; resize: vertical; }
  .row button, .peer { font: 12px ui-monospace, monospace; }
  .chan, .ghost {
    background: #232a3a; color: #dfe3ec; border: 1px solid #3a4460;
    border-radius: 6px; padding: 3px 8px; cursor: pointer;
  }
  .chan:disabled { background: #1d3a2a; border-color: #2f6b45; cursor: default; }
  .chan:hover:not(:disabled), .ghost:hover { background: #2d3650; }
  .chan.ink-on { background: #1d3a2a; border-color: #2f6b45; color: #7bd88f; }
  .thumbs { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
  .thumbs img {
    max-width: 96px; max-height: 72px; border: 1px solid #2a3140; border-radius: 6px;
  }
  .peer { color: #cfd6e4; margin-top: 2px; }
  .peer .role {
    color: #8ab4f8; border: 1px solid #2a3140; border-radius: 4px;
    padding: 0 4px; margin-right: 4px; font-size: 10px;
  }
  .leader {
    font: 11px ui-monospace, monospace; color: #cfd6e4;
    border: 1px solid #3a4460; background: #232a3a; border-radius: 6px;
    padding: 4px 8px; margin: 0 2px 10px;
  }
`;

function Panel() {
  const [windowId, setWindowId] = createSignal<number | undefined>();
  const [rev, setRev] = createSignal(0);
  const [turnStatus, setTurnStatus] = createSignal("");
  const [loweredPrompt, setLoweredPrompt] = createSignal<string | undefined>();

  const session = SessionPane({ windowId });

  // ── the /tools link: tab-activation reporting, tied to the binding ────────
  // Solid 2.0 createEffect(compute, effect): the compute tracks (port,
  // windowId); the effect rewires the link when either changes and returns its
  // teardown, which runs before the next rewire and on panel dispose. (A
  // one-arg createEffect throws MISSING_EFFECT_FN at runtime in Solid 2.0.)
  createEffect(
    () => ({ port: session.handle.port(), win: windowId() }),
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
  const [selectionPresent, setSelectionPresent] = createSignal(false);

  const turnHost = attachTurnHost({
    engine,
    port: session.handle.port,
    activeTab: async () => {
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
    },
    onError: (message) => setTurnStatus(`⚠ ${message}`),
    onLoweredPrompt: (prompt) => {
      setLoweredPrompt(prompt);
      setTurnStatus("sent ✓ — the lowered prompt is in the session");
    },
    persist: mirror.persist,
  });

  // ── capture state: shots + per-tab ink (step 5) ────────────────────────────
  const [captureStatus, setCaptureStatus] = createSignal("");
  const [inkOn, setInkOn] = createSignal(false);
  /** The tab whose content script holds the ink surface, while ink is on. */
  let inkTabId: number | undefined;
  /** Strokes since the last clear — gates the ink-clear events (no ink, no event). */
  let strokesSinceClear = 0;
  /** The window's active tab as last seen — the `from` side of a tab boundary. */
  let lastActiveTab: { id: number; url?: string } | undefined;

  /**
   * Leave ink MODE: release the tab's pointer, KEEP the strokes on screen
   * (decided live 2026-07-11 — exiting the mode must not erase the sketch;
   * that surprised as data loss). No engine event: nothing was cleared.
   * `inkTabId` stays set while strokes remain, so a later clear finds them.
   */
  const inkModeOff = async (): Promise<void> => {
    if (!inkOn()) {
      return;
    }
    setInkOn(false);
    if (inkTabId !== undefined) {
      await relayRequestTab(inkTabId, "page", "ink", { on: false }).catch(() => {});
    }
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
   * turns); the POINTER claim it implies is per-turn: toggling on outside a
   * turn just sets the flag, and the next turn entry claims the pointer.
   */
  const toggleInkMode = (): void => {
    if (inkOn()) {
      void inkModeOff();
    } else if (phase() === "turn") {
      void inkModeOn();
    } else {
      setInkOn(true);
      setCaptureStatus("ink mode on — the pointer claims when a turn opens (⌘B)");
    }
  };

  const inkModeOn = async (): Promise<void> => {
    const win = windowId();
    if (win === undefined) {
      return;
    }
    const [tab] = await chrome.tabs.query({ active: true, windowId: win });
    if (tab?.id === undefined) {
      setCaptureStatus("⚠ no active tab");
      return;
    }
    try {
      await relayRequestTab(tab.id, "page", "ink", {
        on: true,
        fadeSec: engine.settings.inkFadeSec,
      });
    } catch (err) {
      setCaptureStatus(
        `⚠ ink failed: ${err instanceof Error ? err.message : String(err)} (reload the tab?)`,
      );
      return;
    }
    inkTabId = tab.id;
    setInkOn(true);
    setCaptureStatus("ink on — draw on the page; strokes land in shots natively");
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
      setCaptureStatus("⚠ no active tab");
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
    setCaptureStatus("capturing…");
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
      // §13.6: manual shots flash; share-sampled frames (Phase C) never will.
      void relayRequestTab(tab.id, "page", "flash", { kind: "shot" }).catch(() => {});
      const marker = engine.shotDone(
        { x: 0, y: 0, w: vp.w, h: vp.h },
        [],
        grab.thumb,
        undefined,
        true,
        takenAt,
      );
      await turnHost.uploadAttachment(marker, "image/png", dataUrlToBytes(grab.png));
      setCaptureStatus(`${marker} captured (${grab.width}×${grab.height})`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Stamp the time so a REPEATED failure visibly changes — an unchanged
      // status line reads as "the button did nothing" (found live, 2026-07-11).
      const at = new Date().toLocaleTimeString();
      setCaptureStatus(
        isNotInvokedError(message)
          ? `⚠ ${at} — tab not invoked: press ⌘B twice (cancel + reopen the turn invokes THIS ` +
              "tab) or click the aiui toolbar button, then retry"
          : `⚠ shot failed: ${message}`,
      );
    }
  };

  // Ring broadcast to this window's tabs (§13.6: the ring is the page's ONLY
  // evidence — armed = steady, in-turn = breathing). Also runs at boot: a
  // reopened panel starts disarmed, and without the boot sync a ring lit by
  // the previous panel document would stay lit forever (found live).
  const broadcastRing = (): void => {
    const win = windowId();
    const on = phase() !== "disarmed";
    const composing = phase() === "turn" || phase() === "tweak";
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
  engine.onEvent((event) => {
    setRev((r) => r + 1);
    if (event.type === "armed") {
      // ⚠ Phase-B bridge: engine.send() disarms (reference behavior). Under
      // §13.6 send keeps you armed — re-arm immediately unless the panel
      // itself is disarming (phase already "disarmed" then).
      if (!event.on && phase() !== "disarmed") {
        engine.setArmed(true);
      }
    }
    // An engine-side thread close (send ack path, future timeouts) must land
    // the phase back at "armed" — §13.6: turn ends, you STAY armed, no new
    // turn auto-begins. Ink strokes are NOT touched (divergence 5 clears them
    // only on disarm).
    if (event.type === "thread-close" && (phase() === "turn" || phase() === "tweak")) {
      leavePhaseTurn("armed");
    }
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
      if (phase() === "turn" || phase() === "tweak") {
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
      if (phase() === "turn") {
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
            fadeSec: engine.settings.inkFadeSec,
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
      setTurnStatus("⚠ no active tab");
      return;
    }
    try {
      const payload = await relayRequestTab<AppSelection | null>(tab.id, "page", "selection");
      if (payload === null) {
        setTurnStatus("no selection on the page");
        return;
      }
      engine.appSelection(payload);
      setTurnStatus("selection added to the turn");
    } catch (err) {
      setTurnStatus(
        `⚠ selection pull failed: ${err instanceof Error ? err.message : String(err)} (reload the tab?)`,
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
  const [phase, setPhase] = createSignal<"disarmed" | "armed" | "turn" | "tweak">("disarmed");
  /** The rejected key currently blipping in the strip (`× g`), if any. */
  const [blip, setBlip] = createSignal<string | undefined>();
  let blipTimer: number | undefined;
  /** The tab whose content script holds the key capture, while in-turn. */
  let leaderTabId: number | undefined;

  const leaderState = (): LeaderState => ({
    phase: phase() === "disarmed" ? "armed" : (phase() as "armed" | "turn" | "tweak"),
    inkOn: inkOn(),
    selectionPresent: selectionPresent(),
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
    pointCaptureAt(undefined);
    if (inkTabId !== undefined) {
      void relayRequestTab(inkTabId, "page", "ink", { on: false }).catch(() => {});
    }
    broadcastRing();
  };

  /** Enter the in-turn phase (⌘B open or tweak-resume): capture on. */
  const enterPhaseTurn = async (): Promise<void> => {
    setPhase("turn");
    broadcastRing();
    const tabId = await activeTabId();
    if (tabId !== undefined && phase() === "turn") {
      pointCaptureAt(tabId);
      // Re-apply the standing ink-mode flag: the pointer claim is per-turn.
      if (inkOn()) {
        inkTabId = tabId;
        void relayRequestTab(tabId, "page", "ink", {
          on: true,
          fadeSec: engine.settings.inkFadeSec,
        }).catch(() => {});
      }
    }
  };

  /** End the open turn: `send` lowers it, `cancel` drops it. STAY ARMED. */
  const endTurn = (how: "send" | "cancel"): void => {
    // ⚠ Phase-B bridge: the engine thread only exists once a contentful act
    // happened (no explicit open verb yet), so guard the engine verbs.
    if (how === "send") {
      if (engine.threadOpen) {
        engine.send(); // emits thread-close + armed(false); bridges re-arm
      } else {
        setTurnStatus("nothing in the turn — cancelled");
      }
    } else if (engine.threadOpen) {
      engine.stepOut(); // in-thread: closes with reason "cancel", stays armed
    }
    if (phase() === "turn" || phase() === "tweak") {
      leavePhaseTurn("armed");
    }
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
    setTurnStatus("disarmed — everything abandoned (⌘B arms and starts a turn)");
  };

  /**
   * The leader (⌘B) — the state-dependent verb of §13.6's table:
   * disarmed → arm + open a turn · armed → open a turn · in-turn → step out
   * (cancel the turn) · tweak → RESUME the same turn.
   */
  const leaderPress = async (): Promise<void> => {
    switch (phase()) {
      case "disarmed":
        engine.setArmed(true);
        await enterPhaseTurn();
        setTurnStatus("turn open — compose (⏎ sends, esc cancels, t tweaks)");
        return;
      case "armed":
        await enterPhaseTurn();
        setTurnStatus("turn open — compose (⏎ sends, esc cancels, t tweaks)");
        return;
      case "turn":
        endTurn("cancel");
        setTurnStatus("turn cancelled — still armed (⌘B starts the next)");
        return;
      case "tweak":
        await enterPhaseTurn();
        setTurnStatus("turn resumed");
        return;
    }
  };

  const leaderDispatch = (action: LeaderAction): void => {
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
      setTurnStatus("turn cancelled — still armed (⌘B starts the next)");
      return;
    }
    if (action === "tweak") {
      leavePhaseTurn("tweak");
      setTurnStatus("tweak — the page has keyboard and pointer; ⌘B resumes the turn");
      return;
    }
    if (session.handle.port() === undefined) {
      setTurnStatus("⚠ bind a channel first (Session pane)");
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
    blipTimer = window.setTimeout(() => setBlip(undefined), LEADER_BLIP_MS);
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
      leaderDispatch(verdict.action);
    } else if (verdict.kind === "ignored") {
      blipKey(verdict.key);
    }
    return "handled";
  };

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
      const composing = phase() === "turn" || phase() === "tweak";
      chrome.tabs
        .sendMessage(helloTab.id, {
          aiuiRing: 1,
          armed: phase() !== "disarmed" && !composing,
          turn: composing,
        })
        .catch(() => {});
      if (phase() === "turn" && helloTab.active) {
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
    // surprise second turn.
    const recovered = await mirror.recover();
    if (recovered !== undefined) {
      engine.replay(recovered.events, { threadOpen: recovered.threadOpen });
      if (recovered.threadOpen) {
        await enterPhaseTurn();
      } else {
        setPhase("armed"); // replay forces engine.armed = true
        broadcastRing();
      }
      setTurnStatus(
        `recovered an in-progress turn (${recovered.events.length} events) — ⏎ sends, esc discards`,
      );
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

  const [swPing, setSwPing] = createSignal("…");
  relayRequest<{ at: string }>("sw", "ping")
    .then((r) => setSwPing(`service worker alive (${r.at.slice(11, 19)})`))
    .catch((e) => setSwPing(`service worker unreachable: ${String(e)}`));

  const chipClass = () =>
    session.handle.bus().phase === "connected"
      ? "chip on"
      : session.handle.port() !== undefined
        ? "chip connecting"
        : "chip";

  return (
    <>
      <style>{PANEL_STYLES}</style>
      <div class="hdr">
        <span class="mark">✳ aiui</span>
        <span class={phase() === "disarmed" ? "arm" : "arm on"}>
          {phase() === "disarmed" ? "disarmed — ⌘B" : phase()}
        </span>
        <button
          type="button"
          class="ghost"
          disabled={phase() === "disarmed"}
          title="abandon everything: turn, ink, standing tools (§13.6)"
          onClick={() => disarm()}
        >
          disarm
        </button>
        <span class={chipClass()}>
          <span class="dot" />
          {session.handle.port() !== undefined ? `:${session.handle.port()}` : "no channel"}
        </span>
        <span class="win">win {windowId() ?? "?"}</span>
      </div>
      {phase() === "turn" ? (
        <div class="leader">
          ⌨ {leaderHintText(leaderState())}
          {blip() !== undefined ? ` — × ${blip()}` : ""}
        </div>
      ) : null}
      {phase() === "tweak" ? <div class="leader">🔧 tweak — ⌘B resumes the turn</div> : null}
      <PaneStack>
        <TurnPane
          engine={engine}
          rev={rev}
          canCompose={() => phase() === "turn"}
          onNoTurn={() => setTurnStatus("⚠ no turn open — ⌘B starts one")}
          onSend={() => endTurn("send")}
          onCancel={() => {
            endTurn("cancel");
            setTurnStatus("turn cancelled — still armed (⌘B starts the next)");
          }}
          status={turnStatus}
          loweredPrompt={loweredPrompt}
          onAddSelection={() => void addSelection()}
          selectionPresent={selectionPresent}
        />
        <CapturePane
          engine={engine}
          rev={rev}
          onShot={() =>
            phase() === "turn"
              ? void takeShot()
              : setCaptureStatus("⚠ no turn open — ⌘B starts one")
          }
          inkOn={inkOn}
          onInkToggle={() => toggleInkMode()}
          onInkClear={() => void inkClear("manual")}
          status={captureStatus}
        />
        {session.view()}
        <Pane title="Dev" defaultOpen={false} hint="step 1">
          <div class="kv">{swPing()}</div>
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
