/**
 * main.tsx — the detached plain page (the client's HOME, per the plan; the
 * MV3 extension will be a shell around this, not the other way around).
 *
 * Boot decides the lane tier from the world, not a build flag:
 *  - a reachable channel (same origin, or `?channel=<port>`) → the REAL
 *    lanes: shared intent pipeline + wire + talk + speech + frame pump,
 *    session bus driving the `connected` fact;
 *  - no channel → the FakeBus + console lanes, fully exercisable offline
 *    (the harness tier), with the simulate strip standing in for the world.
 *
 * Either way the machine, claims, bar, pills, and keys are IDENTICAL — the
 * tier only swaps the host and the lanes, which is the whole architecture.
 */

import { render } from "@solidjs/web";
import { createSignal, Show } from "solid-js";
import { activationGesture } from "../activation";
import { createIntentClient, type IntentClient, type IntentLanes } from "../client";
import { fakeBus } from "../fake-bus";
import { keyVerdict } from "../keys";
import { createChannelLanes } from "../lanes";
import { connectSessionBus, probeChannel, resolveChannelPort } from "../session";
import { Panel } from "./panel";

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

async function boot(): Promise<{ client: IntentClient; mode: "channel" | "fake" }> {
  // The FakeBus hosts BOTH tiers today: page-side capabilities (ink, keys,
  // ring, selection) get real transports in Phase 3 (CdpBus) and Phase 4
  // (ExtensionBus); the channel tier already carries the real wire/talk.
  const bus = fakeBus({ activeTab: 1 });

  const port = resolveChannelPort();
  const health = port !== undefined ? await probeChannel(port) : undefined;

  if (port !== undefined && health !== undefined) {
    const channelLanes = createChannelLanes({
      host: bus,
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
      host: bus,
      lanes: channelLanes.lanes,
      claimOptions: channelLanes.claimOptions,
      onBlip: (key) => blipSink?.(key),
    });
    channelLanes.bind(client);

    // The session bus is the `connected` fact (and, later, peers/slots —
    // the iPad paint presence). Outages never disarm; they just gray the pill.
    const sessionBus = connectSessionBus({ port, label: "intent client (detached page)" });
    sessionBus.onChange((state) => {
      client.setContext({ connected: state.phase === "connected" });
    });

    (window as unknown as { __aiuiIntentClient?: unknown }).__aiuiIntentClient = {
      client,
      bus,
      lanes: channelLanes,
      sessionBus,
    };
    return { client, mode: "channel" };
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
  return { client, mode: "fake" };
}

let blipSink: ((key: string) => void) | undefined;
let navCounter = 0;

const { client, mode } = await boot();
const bus = (window as unknown as { __aiuiIntentClient: { bus: ReturnType<typeof fakeBus> } })
  .__aiuiIntentClient.bus;

// The activation shortcut — an IMPERATIVE event outside the modal keyboard
// system (chrome.commands in the extension; this listener here). See
// ../activation.ts, the reference imperative-boundary example.
const activate = (): void => {
  activationGesture(client, bus.targeting.activeTab());
};

// Document keys — the same verdicts the content-script forwarding uses.
const onKey = (phase: "down" | "up") => (event: KeyboardEvent) => {
  if (event.metaKey && event.key === "b") {
    event.preventDefault();
    activate();
    return;
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

/** Dev-only: the world facts the real hosts will supply, as buttons. */
function SimulateStrip() {
  return (
    <details
      style="margin: 12px 0 0 12px; font: 12px system-ui; opacity: 0.8"
      open={mode === "fake"}
    >
      <summary>
        {mode === "channel"
          ? "channel tier (real wire) — simulate page-side facts"
          : "fake tier (no channel found) — simulate everything"}
      </summary>
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
      <SimulateStrip />
      <Panel client={client} registerBlipSink={(sink) => (blipSink = sink)} />
      <WirePane />
    </>
  ),
  root,
);
