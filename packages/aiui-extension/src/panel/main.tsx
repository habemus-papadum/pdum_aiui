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
import { SessionPane } from "./session-pane";
import { connectToolsLink, type ToolsLink } from "./tools-link";
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
`;

function Panel() {
  const [windowId, setWindowId] = createSignal<number | undefined>();
  const [rev, setRev] = createSignal(0);
  const [armed, setArmed] = createSignal(false);
  const [turnStatus, setTurnStatus] = createSignal("");
  const [loweredPrompt, setLoweredPrompt] = createSignal<string | undefined>();

  const session = SessionPane({ windowId });

  // ── the /tools link: tab-activation reporting, tied to the binding ────────
  let toolsLink: ToolsLink | undefined;
  createEffect(() => {
    const port = session.handle.port();
    const win = windowId();
    toolsLink?.close();
    toolsLink =
      port !== undefined && win !== undefined
        ? connectToolsLink({ port, windowId: win })
        : undefined;
  });

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
   * Leave ink mode: clear + unmount the tab's surface, then record why the
   * strokes went away — `manual` is the user's toggle (the overlay's C),
   * `boundary` a tab switch (the SPA navigation rule: emitted AFTER the
   * `navigation` event so stroke attribution reads correctly), `none` a
   * thread-close/disarm (nothing may land after the close event).
   */
  const inkModeOff = async (clearEvent: "manual" | "boundary" | "none"): Promise<void> => {
    if (!inkOn()) {
      return;
    }
    setInkOn(false);
    const tabId = inkTabId;
    inkTabId = undefined;
    const hadStrokes = strokesSinceClear > 0;
    strokesSinceClear = 0;
    if (tabId !== undefined) {
      await relayRequestTab(tabId, "page", "ink", { on: false }).catch(() => {});
    }
    if (hadStrokes && engine.threadOpen) {
      if (clearEvent === "manual") {
        engine.inkCleared(false);
      } else if (clearEvent === "boundary") {
        engine.inkCleared(true, "navigation");
      }
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
    // A mode is entered from the armed state (§13.5); entering it IS intent.
    if (!engine.armed) {
      engine.setArmed(true);
    }
    inkTabId = tab.id;
    strokesSinceClear = 0;
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
      // A shot is a deliberate act: it arms, and shotDone opens the turn.
      if (!engine.armed) {
        engine.setArmed(true);
      }
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
          ? `⚠ ${at} — tab not invoked: click the aiui toolbar button on THIS tab, then retry`
          : `⚠ shot failed: ${message}`,
      );
    }
  };

  // Reactive bridge + armed broadcast to this window's tabs. The broadcast
  // also runs at boot: a reopened panel starts with a fresh (disarmed) engine,
  // and without the boot sync a ring lit by the previous panel document would
  // stay lit forever (found live, 2026-07-11).
  const broadcastArmed = (on: boolean): void => {
    const win = windowId();
    if (win !== undefined) {
      void chrome.tabs.query({ windowId: win }).then((tabs) => {
        for (const tab of tabs) {
          if (tab.id !== undefined) {
            chrome.tabs.sendMessage(tab.id, { aiuiArm: 1, armed: on }).catch(() => {});
          }
        }
      });
    }
  };
  engine.onEvent((event) => {
    setRev((r) => r + 1);
    if (event.type === "armed") {
      setArmed(event.on);
      broadcastArmed(event.on);
    }
    // Send/cancel/disarm ends ink mode with the turn (§8: a send clears the
    // ink; strokes die with their thread) — no clear event after the close.
    if (event.type === "thread-close" || (event.type === "armed" && !event.on)) {
      void inkModeOff("none");
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
      engine.strokeDone(m.points, m.bounds); // opens the turn (armed with ink mode)
    }
    if (m.aiuiInkClear === 1 && sender.tab?.id === inkTabId) {
      strokesSinceClear = 0;
      if (engine.threadOpen) {
        engine.inkCleared(true);
      }
    }
    return false;
  });

  // ── tab provenance: activation is a context boundary (proposal §2) ─────────
  // On an open turn, a tab switch within this window emits `navigation` with
  // the two tabs' URLs — ordering in the log attributes everything before it
  // to `from`. Ink follows the SPA rule: strokes must not float over a tab
  // they weren't drawn on, so the boundary also ends ink mode.
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
      await inkModeOff("boundary");
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
      if (!engine.armed) {
        engine.setArmed(true);
      }
      engine.appSelection(payload); // opens the turn itself when none is open
      setTurnStatus("selection added to the turn");
    } catch (err) {
      setTurnStatus(
        `⚠ selection pull failed: ${err instanceof Error ? err.message : String(err)} (reload the tab?)`,
      );
    }
  };

  // ── boot: window id, armed sync, then turn recovery from the mirror ───────
  void chrome.windows.getCurrent().then(async (w) => {
    setWindowId(w.id);
    broadcastArmed(engine.armed);
    if (w.id !== undefined) {
      const [tab] = await chrome.tabs.query({ active: true, windowId: w.id });
      if (tab?.id !== undefined) {
        lastActiveTab = { id: tab.id, ...(tab.url !== undefined ? { url: tab.url } : {}) };
      }
    }
    const recovered = await mirror.recover();
    if (recovered !== undefined) {
      engine.replay(recovered.events, { threadOpen: recovered.threadOpen });
      setTurnStatus(
        `recovered an in-progress turn (${recovered.events.length} events) — Send finalizes, cancel discards`,
      );
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
        <button
          type="button"
          class={armed() ? "arm on" : "arm"}
          disabled={!armed() && session.handle.port() === undefined}
          title={
            !armed() && session.handle.port() === undefined
              ? "bind a channel first (Session pane)"
              : undefined
          }
          onClick={() => engine.setArmed(!engine.armed)}
        >
          {armed() ? "armed" : "disarmed"}
        </button>
        <span class={chipClass()}>
          <span class="dot" />
          {session.handle.port() !== undefined ? `:${session.handle.port()}` : "no channel"}
        </span>
        <span class="win">win {windowId() ?? "?"}</span>
      </div>
      <PaneStack>
        <TurnPane
          engine={engine}
          rev={rev}
          armed={armed}
          onArmToggle={() => engine.setArmed(true)}
          status={turnStatus}
          loweredPrompt={loweredPrompt}
          onAddSelection={() => void addSelection()}
          selectionPresent={selectionPresent}
        />
        <CapturePane
          engine={engine}
          rev={rev}
          onShot={() => void takeShot()}
          inkOn={inkOn}
          onInkToggle={() => void (inkOn() ? inkModeOff("manual") : inkModeOn())}
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
