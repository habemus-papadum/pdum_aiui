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
import {
  createTalk,
  SpeechPlayer,
  WorkletPcmSource,
} from "@habemus-papadum/aiui-dev-overlay/multimodal-talk";
import { VideoSampler } from "@habemus-papadum/aiui-dev-overlay/multimodal-video";
import { isErrorMessage } from "@habemus-papadum/aiui-dev-overlay/protocol";
import { createWire } from "@habemus-papadum/aiui-dev-overlay/wire";
import { CellView, liveSignal } from "@habemus-papadum/aiui-viz";
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
import { isNotInvokedError, type StreamIdReply } from "../capture";
import { grabShot, holdTabStream, releaseTabStream, streamHeldFor } from "./capture";
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
import {
  inkFade,
  inkMode,
  inkVanish,
  linter,
  shotFlash,
  stt,
  uiScale,
  videoMode,
  videoOn,
  videoPeriodSec,
} from "./model/store";
import { createPanelPaint } from "./paint";
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
  /* The config bar: compact selects under the caps. */
  .config-bar { display: flex; gap: 0.625rem; align-items: center; flex-wrap: wrap;
    margin: 0 0.125rem 0.375rem; }
  .config-bar label { display: inline-flex; gap: 0.3rem; align-items: center;
    font: 0.6875rem ui-monospace, monospace; color: var(--muted); }
  .config-bar select { background: var(--input-bg); color: var(--text);
    border: 1px solid var(--border-2); border-radius: 6px; padding: 0.125rem 0.375rem;
    font: 0.75rem ui-monospace, monospace; }
  /* The REC meter: under the caps while the mic loop runs. */
  .rec-meter { height: 0.375rem; margin: 0.25rem 0.125rem 0; border-radius: 999px;
    background: var(--surface-2); border: 1px solid var(--border-2); overflow: hidden; }
  .rec-meter[hidden] { display: none; }
  .rec-meter-fill { height: 100%; width: 0; border-radius: 999px;
    background: var(--ok); transition: width 60ms linear; }
  .rec-meter.muted { border-color: var(--warn); }
  .rec-meter.muted .rec-meter-fill { background: var(--warn); }
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
  const engine = new Engine(panelIntentConfig(stt.get(), linter.get()));
  const mirror = turnMirror(windowId);
  // PULL selection model (decided 2026-07-11): nothing enters the turn until
  // the user's explicit "add selection", which opens the turn itself when none
  // is open (engine.appSelection arms-gated thread opening). No staging.
  const selectionPresent = liveSignal(false);

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
    enqueueSpeech: (clip) => speechPlayer.enqueue(clip),
  });

  // ── talk (C5): the overlay's shell lanes, composed with panel seams. The
  // mic lives in THIS document (M9) — it survives tab switches and dies with
  // the panel, and PCM/segments ride the wire the panel already owns.
  const speechPlayer = new SpeechPlayer();
  let listeningIsHold = false;
  const talk = createTalk({
    engine,
    config: () => engine.settings,
    // MV3 CSP blocks blob: worklet modules (measured 2026-07-13) — load the
    // shipped copy, pinned to the shared constant by worklet-file.test.ts.
    pcmSource: () => new WorkletPcmSource({ workletUrl: chrome.runtime.getURL("pcm-worklet.js") }),
    setStatus: (text) => logInfo("talk:", text),
    reportError: (error) => toast(`${error.source ?? "talk"}: ${error.message}`),
    bargeIn: () => speechPlayer.bargeIn(),
    getThread: () => wire.getThread(),
    flushOutbox: (known) => wire.flushOutbox(known),
    uploadAttachment: (id, mime, bytes) => wire.uploadAttachment(id, mime, bytes),
    uploadAudio: (segment, seq, bytes) => wire.uploadAudio(segment, seq, bytes),
  });

  // ── capture state: shots + per-tab ink (step 5) ────────────────────────────
  // The standing ink-mode flag: a liveSignal for machine + UI (the claim
  // derivations read it right after writing it), persisted through the
  // store's durableSignal so it survives panel hot swaps (§13.6).
  const inkOnLive = liveSignal(inkMode.get());
  const inkOn = (): boolean => inkOnLive.get();
  const setInkOn = (on: boolean): void => {
    inkOnLive.set(on);
    inkMode.set(on);
  };
  /** The tab whose content script holds the ink surface, while ink is on. */
  let inkTabId: number | undefined;
  /** Strokes since the last clear — gates the ink-clear events (no ink, no event). */
  let strokesSinceClear = 0;
  /** The window's active tab as last seen — the `from` side of a tab boundary. */
  let lastActiveTab: { id: number; url?: string } | undefined;

  /**
   * The TAB STREAM claim, derived exactly like the ink pointer: the panel holds
   * a warm tabCapture stream for the active tab while a turn is open, so a shot
   * is a draw, not an acquisition (measured: acquiring costs ~148ms — paying it
   * per shot is what made captures feel slow; see panel/capture.ts).
   *
   * Failure is NOT fatal here: the invocation gate (a tab never invoked) simply
   * means no warm stream — `takeShot` then reports the ⌘B remedy. Warming is
   * silent; only an actual shot complains.
   */
  const syncTabStream = async (): Promise<void> => {
    const tabId = await activeTabId();
    if (phase.get() !== "turn" || tabId === undefined) {
      releaseTabStream();
      return;
    }
    if (streamHeldFor(tabId)) {
      return;
    }
    try {
      await holdTabStream(tabId, async (id) => {
        const reply = await relayRequest<StreamIdReply>("sw", "streamId", { tabId: id });
        return reply.streamId;
      });
      logDebug("tab stream warm for tab", tabId);
    } catch (err) {
      // Expected on a never-invoked tab; the shot path says what to do.
      logDebug("no warm stream:", err instanceof Error ? err.message : String(err));
    }
  };

  /**
   * The ink POINTER claim, DERIVED — never toggled ad hoc. It is on iff a turn
   * is open AND ink mode is on: tweak hands the page back BOTH keyboard and
   * pointer (found live 2026-07-12 — ink kept drawing in tweak), and resuming
   * re-claims it. The mode FLAG and the strokes are untouched (standing
   * state, §13.6). Resolved against the LIVE active tab, so a tab switch or a
   * stale id can't strand the claim.
   */
  const syncInkPointer = async (): Promise<void> => {
    const want = phase.get() === "turn" && inkOn();
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
    await relayRequestTab(tabId, "page", "ink", {
      on: true,
      fadeSec: inkVanish.get() ? inkFade.get() : 0,
    }).catch(() => {
      // The page can't hear us — usually an orphaned/absent content script
      // (the SW re-injects on reload now, but a page can still predate an
      // install). Loud, because the user just asked for ink and got nothing.
      toast("ink can't reach this page — reload the tab");
    });
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
   * One whole-viewport shot of the active tab — off the WARM stream the panel
   * already holds (syncTabStream), so this is a draw + an encode and nothing
   * else: no acquisition (~148ms saved), no offscreen document, no base64
   * across two message hops. The engine event carries the thumb; the encoded
   * bytes ride the thread socket as an `attachment` chunk keyed by the shot's
   * marker — the overlay wire's exact shape.
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
    const tShot = performance.now();
    try {
      // The stream is normally already warm (the turn warmed it). If it is
      // not — a tab switch racing the shot, a tab that only just became
      // invocable — acquire now and pay the ~148ms once.
      if (!streamHeldFor(tab.id)) {
        await holdTabStream(tab.id, async (id) => {
          const reply = await relayRequest<StreamIdReply>("sw", "streamId", { tabId: id });
          return reply.streamId;
        });
      }
      const shot = await grabShot();
      // Camera-style confirmation, strictly AFTER the frame is grabbed so the
      // wash can never be in the frame it confirms. §13.6: manual shots flash
      // (the shotFlash control is the easy off); share-sampled frames never do.
      if (shotFlash.get()) {
        void relayRequestTab(tab.id, "page", "flash", { kind: "shot" }).catch(() => {});
      }
      logDebug("shot latency (ms):", {
        total: Math.round(performance.now() - tShot),
        ...shot.timing,
      });
      const marker = engine.shotDone(
        { x: 0, y: 0, w: shot.width, h: shot.height },
        [],
        shot.thumb,
        undefined,
        true,
        takenAt,
      );
      // Bytes straight to the wire — the panel owns the socket, so there is
      // nothing to marshal.
      await wire.uploadAttachment(marker, shot.mime, shot.bytes);
      logInfo(`${marker} captured (${shot.width}×${shot.height}, ${shot.timing.kb}KB)`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // The invocation gate is THE sanctioned toast case (misuse feedback);
      // toasts dedupe with ×N, so repeats visibly change.
      toast(
        isNotInvokedError(message)
          ? "aiui can't see this tab yet — press ⌘B on it (a leader press is what grants " +
              "capture), then retry"
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
    const on = phase.get() !== "disarmed";
    const composing = phase.get() === "turn" || phase.get() === "tweak";
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
      if (phase.get() === "turn" || phase.get() === "tweak") {
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
      selectionPresent.set(m.present === true);
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
      if (phase.get() === "turn" || phase.get() === "tweak") {
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
      if (phase.get() === "turn") {
        pointCaptureAt(info.tabId);
        // Both claims follow the active tab: the ink pointer (the old tab keeps
        // its strokes — page state) and the capture stream (one per tab).
        await syncInkPointer();
        await syncTabStream();
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
  // The machine's state is a liveSignal (aiui-viz) — read-your-own-writes:
  // the machine writes it and BRANCHES on it in the same synchronous flow,
  // which a plain signal gets wrong under Solid 2.0's write batching (found
  // live 2026-07-12: the ring broadcast one state behind; a synchronous
  // engine event stomped a disarm back to armed). The primitive is the
  // distilled form of the mirror pair that used to live here and in four
  // other spots — live-signal.ts's docblock tells the story.
  type Phase = "disarmed" | "armed" | "turn" | "tweak";
  const phase = liveSignal<Phase>("disarmed");
  /** The rejected key currently blipping (`× g`), if any. */
  const blip = liveSignal<string | undefined>(undefined);
  let blipTimer: number | undefined;
  /** The tab whose content script holds the key capture, while in-turn. */
  let leaderTabId: number | undefined;

  const leaderState = (): LeaderState => ({
    phase: phase.get() === "disarmed" ? "armed" : (phase.get() as "armed" | "turn" | "tweak"),
    inkOn: inkOnLive.get(),
    selectionPresent: selectionPresent.get(),
    talking: engine.talking || talk.listening(),
    holdTalk: listeningIsHold,
    micMuted: talk.micMuted(),
    videoOn: videoOnLive.get(),
    fpsSmart: videoModeLive.get() === "smart",
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
    previewIsland?.sync(phase.get() === "turn" || phase.get() === "tweak");
    keysIsland?.sync(leaderState(), helpOpen, blip.get());
  };

  // Control mirrors (the liveSignal rule): the caps and the sampler read
  // these right after the dispatch writes them — a bare control read there is
  // one write behind (the video cap showed the OPPOSITE state, seen live).
  const videoOnLive = liveSignal(videoOn.get());
  const videoModeLive = liveSignal(videoMode.get());

  // ── video (C6): periodic tab frames into the open turn — the overlay's
  // VideoSampler over the panel's WARM stream (frames-are-shots: each frame
  // is a quiet shot_N + attachment; no flash, §13.6). Smart mode's gate is
  // the content script's throttled interaction pings.
  let pageInteracted = false;
  chrome.runtime.onMessage.addListener((m: unknown) => {
    if (
      m !== null &&
      typeof m === "object" &&
      (m as { aiuiInteract?: number }).aiuiInteract === 1
    ) {
      pageInteracted = true;
    }
  });
  const sampler = new VideoSampler({
    captureFrame: async () => {
      try {
        const shot = await grabShot();
        return shot; // full Shot; sendFrame downscales markers from it
      } catch {
        return undefined; // no warm stream right now — the tick owes nothing
      }
    },
    sendFrame: (frame, shot) => {
      const marker = engine.shotDone(
        { x: 0, y: 0, w: shot.width, h: shot.height },
        [],
        shot.thumb,
        undefined,
        false, // sampled, not manual — no flash, quieter preview chrome
        Date.now(),
      );
      void wire.uploadAttachment(marker, shot.mime, shot.bytes);
      logDebug("video frame", frame.seq, "→", marker);
    },
    intervalMs: () => (videoMode.get() === "smart" ? 1000 : videoPeriodSec.get() * 1000),
    shouldCapture: () => {
      if (videoModeLive.get() !== "smart") {
        return true;
      }
      const had = pageInteracted;
      pageInteracted = false;
      return had;
    },
    rearm: () => {
      pageInteracted = true; // the tick consumed the gate but delivered nothing
    },
  });
  /** The video claim, derived like ink/stream: sampling iff turn + videoOn. */
  const syncVideo = (): void => {
    const want = phase.get() === "turn" && videoOnLive.get();
    if (want) {
      sampler.start();
    } else {
      sampler.stop();
    }
  };

  // ── iPad ink (C7): the panel is a paint HOST — frames off the warm stream
  // out to the iPad viewer, stroke intents back onto the active tab's ink
  // surface (paint.ts). Reconnects when the channel binding changes.
  let lastTabMeta: { tabId: number; width: number; height: number } | undefined;
  const refreshTabMeta = async (): Promise<void> => {
    const tabId = await activeTabId();
    if (tabId === undefined) {
      return;
    }
    try {
      const vp = await relayRequestTab<{ w: number; h: number }>(tabId, "page", "viewport");
      lastTabMeta = { tabId, width: vp.w, height: vp.h };
    } catch {
      lastTabMeta = { tabId, width: 1280, height: 800 };
    }
  };
  const paint = createPanelPaint({
    port: session.port,
    activeTab: () => lastTabMeta,
    captureFrame: async () => {
      try {
        return (await grabShot()).bytes;
      } catch {
        return undefined; // no warm stream — the viewer just sees no video yet
      }
    },
    openTurn: (on) => {
      if (on && phase.get() !== "turn") {
        void enterPhaseTurn();
      }
    },
    sendInk: (tabId, op) => {
      void chrome.tabs.sendMessage(tabId, op).catch(() => {});
      void refreshTabMeta(); // strokes imply the iPad is live — keep dims fresh
    },
    log: logInfo,
  });
  setInterval(() => paint.sync(), 3000); // binding changes reconnect lazily
  void refreshTabMeta();
  window.addEventListener("pagehide", () => paint.dispose());

  // The REC meter: a tiny rAF island (imperative — never touches signals in
  // its loop; the frontend playbook's bridge rule). Visible only while the
  // mic loop runs; the fill tracks talk.level(), red when muted.
  const meter = document.createElement("div");
  meter.className = "rec-meter";
  meter.hidden = true;
  const meterFill = document.createElement("div");
  meterFill.className = "rec-meter-fill";
  meter.append(meterFill);
  const meterTick = (): void => {
    const on = engine.talking || talk.listening();
    meter.hidden = !on;
    if (on) {
      const muted = talk.micMuted();
      meterFill.style.width = `${Math.round(Math.min(1, muted ? 0 : talk.level()) * 100)}%`;
      meter.classList.toggle("muted", muted);
    }
    requestAnimationFrame(meterTick);
  };
  requestAnimationFrame(meterTick);

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
    keysBarHost?.append(meter);
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
    phase.set(to);
    blip.set(undefined);
    helpOpen = false;
    pointCaptureAt(undefined);
    // Both media claims are DERIVED from (phase, active tab): leaving the turn
    // releases the ink pointer (tweak hands the page back keyboard AND pointer)
    // and the warm capture stream. Strokes and the ink-mode flag persist —
    // standing state (§13.6). The mic loop ends with the turn too.
    talk.stopAllListening();
    void syncInkPointer();
    void syncTabStream();
    syncVideo();
    broadcastRing();
  };

  /** Enter the in-turn phase (⌘B open or tweak-resume): capture on. */
  const enterPhaseTurn = async (): Promise<void> => {
    phase.set("turn");
    // §13.6 divergence 1, now engine-real (C1): the thread opens HERE,
    // explicitly — no-op on tweak-resume (already open). The wire's socket
    // opens on the resulting thread-open event.
    engine.openTurn();
    broadcastRing();
    const tabId = await activeTabId();
    if (tabId !== undefined && phase.get() === "turn") {
      pointCaptureAt(tabId);
    }
    await syncInkPointer(); // re-claims iff the standing ink flag is on
    void syncTabStream(); // warm the capture stream: a shot becomes a draw
    syncVideo(); // resume sampling iff the video flag is on
  };

  /** The open turn holds something worth lowering (explicit turns can be empty). */
  const turnHasContent = (): boolean =>
    composeIntent(currentThreadEvents(engine.events), "replace", { streaming: true }).items.length >
    0;

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
    if (phase.get() === "turn" || phase.get() === "tweak") {
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
    phase.set("armed");
    broadcastRing();
    logInfo("armed — ⌘B starts a turn");
  };

  /** Disarm: abandon EVERYTHING (§13.6) — turn, ink, standing tools, ring. */
  const disarm = (): void => {
    phase.set("disarmed"); // first — the armed(false) bridge checks this
    pointCaptureAt(undefined);
    blip.set(undefined);
    if (engine.threadOpen) {
      engine.stepOut();
    }
    engine.setArmed(false);
    setInkOn(false);
    void inkClear("silent");
    releaseTabStream();
    // Standing tools (hands-free, share) tear down here when they land
    // (Phase C) — the §13.6 contract is recorded now.
    broadcastRing();
    logInfo("disarmed — everything abandoned");
  };

  /**
   * The leader (⌘B) — the state-dependent verb of §13.6's table:
   * disarmed → arm + open a turn · armed → open a turn · tweak → RESUME the
   * same turn · **in-turn → grant THIS tab** (never destructive).
   *
   * Revised 2026-07-12 after live use: ⌘B used to be an escape rung (it
   * cancelled the open turn), which made the natural gesture on a new tab —
   * "let aiui see this one" — silently abandon your turn. Cancelling is Esc's
   * job and disarming is `d`'s; the leader is now IDEMPOTENT. Its press is
   * itself the tabCapture invocation (measured M8), so in-turn it re-points
   * the capture surfaces at the active tab and warms its stream; if that tab
   * is already live it does nothing at all.
   */
  const leaderPress = async (): Promise<void> => {
    switch (phase.get()) {
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
      case "turn": {
        // Idempotent: the press already granted this tab (a commands press is
        // an invocation); make the surfaces follow it and warm the stream.
        const tabId = await activeTabId();
        if (tabId !== undefined) {
          pointCaptureAt(tabId);
        }
        await syncInkPointer();
        const before = tabId !== undefined && streamHeldFor(tabId);
        await syncTabStream();
        if (!before && tabId !== undefined && streamHeldFor(tabId)) {
          logInfo("this tab is now aiui's to see (capture ready)");
        }
        return;
      }
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
    if (action === "talkPress" || action === "handsFree") {
      // Space (hold) and h (toggle) drive the same main loop; Space's keyup
      // ends only a hold — an h-started loop ignores it (listeningIsHold).
      if (talk.listening()) {
        if (action === "handsFree") {
          talk.stopMainListening();
        }
      } else {
        listeningIsHold = action === "talkPress";
        talk.startMainListening();
      }
      syncIslands();
      return;
    }
    if (action === "talkRelease") {
      if (talk.listening() && listeningIsHold) {
        talk.stopMainListening();
        syncIslands();
      }
      return;
    }
    if (action === "mute") {
      talk.setMicMuted(!talk.micMuted());
      syncIslands();
      return;
    }
    if (action === "video") {
      const next = !videoOnLive.get();
      videoOnLive.set(next);
      videoOn.set(next);
      syncVideo();
      syncIslands();
      logInfo(next ? "video sampling on" : "video sampling off");
      return;
    }
    if (action === "fpsMode") {
      const next = videoModeLive.get() === "smart" ? "constant" : "smart";
      videoModeLive.set(next);
      videoMode.set(next);
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
    blip.set(key);
    if (blipTimer !== undefined) {
      clearTimeout(blipTimer);
    }
    blipTimer = window.setTimeout(() => {
      blip.set(undefined);
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
  // A held tab stream must never outlive the panel document.
  window.addEventListener("pagehide", () => releaseTabStream());

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
      const composing = phase.get() === "turn" || phase.get() === "tweak";
      chrome.tabs
        .sendMessage(helloTab.id, {
          aiuiRing: 1,
          armed: phase.get() !== "disarmed" && !composing,
          turn: composing,
        })
        .catch(() => {});
      if (phase.get() === "turn" && helloTab.active) {
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
        phase.set("armed"); // replay forces engine.armed = true
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
      if (inkOn() && inkTabId !== undefined && phase.get() === "turn") {
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
          class={phase.get() !== "disarmed" ? "pill on" : "pill"}
          disabled={phase.get() === "disarmed" && session.port() === undefined}
          title="armed = presence (border only); needs a bound channel. Off-click disarms: abandons turn, ink, standing tools (§13.6)"
          onClick={() => (phase.get() === "disarmed" ? armOnly() : disarm())}
        >
          <span class="dot" />
          armed
        </button>
        <button
          type="button"
          class={phase.get() === "turn" || phase.get() === "tweak" ? "pill turn on" : "pill turn"}
          disabled={phase.get() === "disarmed"}
          title="the open turn (⌘B). Off-click cancels it — you stay armed"
          onClick={() => {
            if (phase.get() === "armed") {
              if (!requireChannel()) {
                return;
              }
              void enterPhaseTurn();
              logInfo("turn open");
            } else if (phase.get() === "turn" || phase.get() === "tweak") {
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
      {phase.get() === "tweak" ? <div class="leader">🔧 tweak — ⌘B resumes the turn</div> : null}
      {/* The config bar: tier / linter / video / fps — the always-there
          settings strip (its dropdowns are plain selects bound to controls;
          the hello reads them at the next thread-open). */}
      <div class="config-bar">
        <label>
          stt
          <select
            value={stt.get()}
            onChange={(e) => {
              stt.set(e.currentTarget.value);
              logInfo("stt →", e.currentTarget.value, "(applies at the next turn)");
            }}
          >
            <option value="gpt-realtime-whisper">gpt-realtime-whisper</option>
            <option value="gpt-4o-mini-transcribe">gpt-4o-mini-transcribe</option>
            <option value="elevenlabs">elevenlabs</option>
          </select>
        </label>
        <label>
          linter
          <select value={linter.get()} onChange={(e) => linter.set(e.currentTarget.value)}>
            <option value="off">off</option>
            <option value="openai">openai</option>
            <option value="gemini">gemini</option>
          </select>
        </label>
        <label title="seconds per frame (constant rate)">
          fps
          <input
            type="range"
            min="1"
            max="10"
            step="1"
            value={videoPeriodSec.get()}
            onInput={(e) => videoPeriodSec.set(Number(e.currentTarget.value))}
          />
        </label>
        <label title="vanishing ink (off = page-permanent)">
          <input
            type="checkbox"
            checked={inkVanish.get()}
            onChange={(e) => {
              inkVanish.set(e.currentTarget.checked);
              void syncInkPointer(); // re-relay the live fade to the page
            }}
          />
          vanish
        </label>
        <label title="ink lifetime, seconds">
          ink
          <input
            type="range"
            min="2"
            max="20"
            step="1"
            value={inkFade.get()}
            onInput={(e) => inkFade.set(Number(e.currentTarget.value))}
          />
        </label>
      </div>
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
          canCompose={() => phase.get() === "turn"}
          onNoTurn={() => toast("no turn open — ⌘B starts one")}
          onSend={() => endTurn("send")}
          onCancel={() => {
            endTurn("cancel");
            logInfo("turn cancelled — still armed");
          }}
          loweredPrompt={loweredPrompt}
          onAddSelection={() => void addSelection()}
          selectionPresent={selectionPresent.get}
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
