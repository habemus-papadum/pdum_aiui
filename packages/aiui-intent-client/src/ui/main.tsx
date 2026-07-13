/**
 * main.tsx — the detached plain page (the client's HOME, per the plan; the
 * MV3 extension will be a shell around this, not the other way around).
 *
 * Boot decides the tier from the world, not a build flag — HOST first, then
 * lanes:
 *  - a reachable channel with a live session browser → the **CdpBus**: real
 *    tabs, driven over the channel's `/intent/cdp` bridge. Ink, keys, ring,
 *    selection and shots land on actual pages, with no extension installed.
 *  - a reachable channel without one → the FakeBus for pages, real lanes for
 *    the wire (the turn still goes to the agent; the page facts are simulated).
 *  - no channel → FakeBus + console lanes: the whole client, offline.
 *
 * The machine, claims, bar, pills, and keys are IDENTICAL in every tier — the
 * tier swaps the host and the lanes, which is the whole architecture.
 */

import { render } from "@solidjs/web";
import { createEffect, createRoot, createSignal, Show } from "solid-js";
import { activationGesture } from "../activation";
import { type CdpBus, connectCdpBus } from "../cdp/cdp-bus";
import { createIntentClient, type IntentClient, type IntentLanes } from "../client";
import { uiScale } from "../config";
import { loadConfigBase, resetConfigToBase, saveConfigBase } from "../config-store";
import { fakeBus } from "../fake-bus";
import { keyVerdict } from "../keys";
import { type ChannelLanes, createChannelLanes } from "../lanes";
import { connectSessionBus, probeChannel, resolveChannelPort } from "../session";
import type { IntentHost } from "../transport";
import { Panel } from "./panel";
import { PANES_STYLES, TracePane, TurnPane } from "./panes";

const [statusLine, setStatusLine] = createSignal("", { ownedWrite: true });
const [loweredPrompt, setLoweredPrompt] = createSignal<string | undefined>(undefined, {
  ownedWrite: true,
});
const [toastLine, setToastLine] = createSignal<string | undefined>(undefined, {
  ownedWrite: true,
});
let toastTimer: ReturnType<typeof setTimeout> | undefined;
const toast = (message: string): void => {
  setToastLine(message);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => setToastLine(undefined), 4000);
};

// The saved config base applies BEFORE the lanes read stt/linter.
loadConfigBase();

// Panel zoom: ⌘+/⌘−/⌘0 drive the uiScale control; the graph pushes the
// root font size (nothing hand-called).
createRoot(() => {
  createEffect(
    () => uiScale.get() as number,
    (scale) => {
      document.documentElement.style.fontSize = `${Math.round(scale * 100)}%`;
    },
  );
});

/**
 * The CdpBus, when this machine's session browser is up: the channel tells us
 * (`/intent/cdp/info`) rather than us probing Chrome — the page CANNOT reach
 * the debug port itself (no CORS on `/json/version`; Chrome rejects a page's
 * websocket upgrade), which is exactly why the bridge exists. Any failure here
 * is not fatal: the panel falls back to the FakeBus and says so.
 */
async function tryCdpHost(port: number): Promise<CdpBus | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/intent/cdp/info`, {
      signal: AbortSignal.timeout(2000),
    });
    const info = (await res.json()) as { available?: boolean; reason?: string };
    if (info.available !== true) {
      setStatusLine(`page hosting: simulated — ${info.reason ?? "no session browser"}`);
      return undefined;
    }
    return await connectCdpBus({
      cdpUrl: `ws://127.0.0.1:${port}/intent/cdp`,
      channelOrigin: `http://127.0.0.1:${port}`,
      log: (message) => console.info("[cdp]", message),
    });
  } catch (err) {
    setStatusLine(`page hosting: simulated — the CDP bridge failed (${String(err)})`);
    return undefined;
  }
}

async function boot(): Promise<{
  client: IntentClient;
  mode: "cdp" | "channel" | "fake";
  lanes?: ChannelLanes;
  fake?: ReturnType<typeof fakeBus>;
  cdp?: CdpBus;
}> {
  // The FakeBus stands in for the world whenever a real host isn't there — in
  // the CDP tier it isn't used at all (the pages are real).
  const bus = fakeBus({ activeTab: 1 });

  const port = resolveChannelPort();
  const health = port !== undefined ? await probeChannel(port) : undefined;

  if (port !== undefined && health !== undefined) {
    const cdp = await tryCdpHost(port);
    const host: IntentHost = cdp ?? bus;
    const channelLanes = createChannelLanes({
      host,
      port: () => port,
      tabMeta: async () => ({ url: location.href, title: document.title, kind: "detached-page" }),
      onStatus: (line) => {
        setStatusLine(line);
        console.info("[intent-client]", line);
      },
      onToast: toast,
      onLoweredPrompt: (prompt) => setLoweredPrompt(prompt),
    });
    const client = createIntentClient({
      host,
      lanes: channelLanes.lanes,
      claimOptions: channelLanes.claimOptions,
      onBlip: (key) => blipSink?.(key),
    });
    channelLanes.bind(client);
    if (channelLanes.recover(client)) {
      setStatusLine("turn recovered from the mirror — re-grant with activate/⌘B");
    }

    // The session bus is the `connected` fact (and, later, peers/slots —
    // the iPad paint presence). Outages never disarm; they just gray the pill.
    const sessionBus = connectSessionBus({ port, label: "intent client (detached page)" });
    sessionBus.onChange((state) => {
      client.setContext({ connected: state.phase === "connected" });
    });

    (window as unknown as { __aiuiIntentClient?: unknown }).__aiuiIntentClient = {
      client,
      bus,
      cdp,
      lanes: channelLanes,
      sessionBus,
    };
    if (cdp !== undefined) {
      setStatusLine(`driving ${cdp.pages().length} real tab(s) over CDP — no extension installed`);
      return { client, mode: "cdp", lanes: channelLanes, cdp };
    }
    return { client, mode: "channel", lanes: channelLanes, fake: bus };
  }

  const consoleLanes: IntentLanes = {
    openTurn: () => console.info("[lanes] openTurn"),
    sendTurn: () => console.info("[lanes] sendTurn"),
    cancelTurn: () => console.info("[lanes] cancelTurn"),
    takeShot: (tab) => console.info("[lanes] takeShot", tab),
    addSelection: (tab) => console.info("[lanes] addSelection", tab),
    clearInk: (tab) => console.info("[lanes] clearInk", tab),
    startTalk: (mode) => console.info("[lanes] startTalk", mode),
    stopTalk: () => console.info("[lanes] stopTalk"),
    setMicMuted: (muted) => console.info("[lanes] setMicMuted", muted),
  };
  const client = createIntentClient({
    host: bus,
    lanes: consoleLanes,
    onBlip: (key) => blipSink?.(key),
  });
  client.setContext({ connected: true }); // the fake tier pretends a channel
  (window as unknown as { __aiuiIntentClient?: unknown }).__aiuiIntentClient = { client, bus };
  return { client, mode: "fake", fake: bus };
}

let blipSink: ((key: string) => void) | undefined;
let navCounter = 0;

const { client, mode, lanes, fake, cdp } = await boot();
/** Whichever host is targeting pages — the CdpBus's real tabs, or the fake's. */
const targeting = cdp?.targeting ?? fake?.targeting;

// The activation shortcut — an IMPERATIVE event outside the modal keyboard
// system (chrome.commands in the extension; this listener here). See
// ../activation.ts, the reference imperative-boundary example.
const activate = (): void => {
  activationGesture(client, targeting?.activeTab());
};

// Document keys — the same verdicts the content-script forwarding uses.
const onKey = (phase: "down" | "up") => (event: KeyboardEvent) => {
  if (event.metaKey && event.key === "b") {
    event.preventDefault();
    activate();
    return;
  }
  // Panel zoom (⌘+/⌘−/⌘0) — panel-document chrome, registered before the
  // grammar so it wins mid-turn (the old panel's rule).
  if (event.metaKey && phase === "down") {
    const scale = uiScale.get() as number;
    if (event.key === "=" || event.key === "+") {
      event.preventDefault();
      uiScale.set((Math.round((scale + 0.1) * 10) / 10) as never);
      return;
    }
    if (event.key === "-") {
      event.preventDefault();
      uiScale.set((Math.round((scale - 0.1) * 10) / 10) as never);
      return;
    }
    if (event.key === "0") {
      event.preventDefault();
      uiScale.set(1 as never);
      return;
    }
  }
  const verdict = keyVerdict(client.state(), event.key, phase, event.repeat);
  if (verdict.kind === "pass") {
    // PANEL-document affordance: outside a turn the grammar claims nothing
    // (on the TARGET page, keys belong to the page — decided) — but in the
    // panel's own document, Esc may still step out (armed → disarmed).
    if (phase === "down" && event.key === "Escape" && client.canDispatch("escape")) {
      event.preventDefault();
      client.dispatch("escape");
    }
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  client.handleKey(event.key, phase, event.repeat);
};
document.addEventListener("keydown", onKey("down"), true);
document.addEventListener("keyup", onKey("up"), true);
window.addEventListener("blur", () => client.emit("windowBlur"));

/** The world facts a real host supplies — as buttons, for the tiers that lack one.
 * In the CDP tier every one of these is REAL (open a tab, select text, click,
 * navigate), so the strip only carries what still has no supplier: the mic grant
 * (until talk is exercised) and the iPad presence (P4). */
function SimulateStrip() {
  const summary =
    mode === "cdp"
      ? `CDP tier — driving real tabs (${cdp?.pages().length ?? 0} attached), no extension`
      : mode === "channel"
        ? "channel tier (real wire, simulated pages) — no session browser found"
        : "fake tier (no channel found) — simulate everything";
  return (
    <details
      style="margin: 12px 0 0 12px; font: 12px system-ui; opacity: 0.8"
      open={mode !== "cdp"}
    >
      <summary>{summary}</summary>
      <div style="display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px">
        <button type="button" data-testid="activate" onClick={activate}>
          activate (the ⌘B stand-in): grant + open
        </button>
        <Show when={mode === "fake"}>
          <button
            type="button"
            onClick={() => client.setContext({ connected: !client.context().connected })}
          >
            channel connect/drop
          </button>
        </Show>
        <button type="button" onClick={() => client.setContext({ micGranted: true })}>
          mic grant
        </button>
        <button type="button" onClick={() => client.setContext({ micGranted: false })}>
          mic deny
        </button>
        <button
          type="button"
          onClick={() =>
            client.setContext({ paintClients: client.context().paintClients > 0 ? 0 : 1 })
          }
        >
          iPad connect/drop
        </button>
        <Show when={fake} keyed>
          {(bus) => (
            <>
              <button
                type="button"
                onClick={() =>
                  bus.firePageEvent({
                    kind: "selectionPresent",
                    tab: bus.targeting.activeTab() ?? 1,
                    present: !client.context().selectionPresent,
                  })
                }
              >
                selection ping
              </button>
              <button
                type="button"
                onClick={() =>
                  bus.firePageEvent({ kind: "interaction", tab: bus.targeting.activeTab() ?? 1 })
                }
              >
                page interaction (smart-video gate)
              </button>
              <button
                type="button"
                onClick={() => {
                  const tab = bus.targeting.activeTab() ?? 1;
                  const n = ++navCounter;
                  bus.firePageEvent({
                    kind: "navigation",
                    tab,
                    from: `fake://tab/${tab}/page/${n - 1}`,
                    to: `fake://tab/${tab}/page/${n}`,
                    navKind: "push",
                  });
                  bus.setTabUrl(tab, `fake://tab/${tab}/page/${n}`);
                }}
              >
                navigate (same tab)
              </button>
              <button
                type="button"
                onClick={() => bus.switchTab(bus.targeting.activeTab() === 1 ? 2 : 1)}
              >
                switch tab 1↔2
              </button>
              <button
                type="button"
                onClick={() =>
                  bus.firePageEvent({
                    kind: "aiuiSupport",
                    tab: bus.targeting.activeTab() ?? 1,
                    supported: !client.context().aiuiPage,
                  })
                }
              >
                aiui page support on/off
              </button>
            </>
          )}
        </Show>
      </div>
    </details>
  );
}

/** The wire's narration: status line · toast · the lowered-prompt echo. */
function WirePane() {
  return (
    <div style="margin: 8px 12px; font: 12px system-ui; opacity: 0.85; max-width: 460px">
      <Show when={toastLine()}>
        {(line) => (
          <div style="color: #dc2626; border: 1px solid #dc2626; border-radius: 6px; padding: 4px 8px; margin-bottom: 6px">
            {line()}
          </div>
        )}
      </Show>
      <Show when={statusLine() !== ""}>
        <div style="opacity: 0.7">{statusLine()}</div>
      </Show>
      <Show when={loweredPrompt()}>
        {(prompt) => (
          <details style="margin-top: 6px" open>
            <summary>lowered prompt (the channel's echo of the sent turn)</summary>
            <pre style="white-space: pre-wrap; font: 11px ui-monospace, monospace">{prompt()}</pre>
          </details>
        )}
      </Show>
    </div>
  );
}

const root = document.getElementById("root");
if (root === null) {
  throw new Error("intent-client page: #root missing");
}
render(
  () => (
    <>
      <style>{PANES_STYLES}</style>
      <SimulateStrip />
      <Panel
        client={client}
        registerBlipSink={(sink) => (blipSink = sink)}
        configActions={{ save: () => saveConfigBase(), reset: () => resetConfigToBase() }}
        micLevel={lanes !== undefined ? () => lanes.talk.level() : undefined}
      />
      <Show when={lanes} keyed>
        {(l) => (
          <>
            <TurnPane lanes={l} />
            <TracePane lanes={l} />
          </>
        )}
      </Show>
      <WirePane />
    </>
  ),
  root,
);
