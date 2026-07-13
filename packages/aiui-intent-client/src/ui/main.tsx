/**
 * main.tsx — the detached plain page (the client's HOME, per the plan; the
 * MV3 extension will be a shell around this, not the other way around).
 *
 * Today it boots over the FakeBus with console lanes — a fully exercisable
 * client with no extension, no CDP, no channel: Vite serves it, HMR works,
 * the devtools MCP can screenshot it, click its caps, and drive its keys.
 * The "simulate" strip stands in for the world facts the real hosts will
 * supply (channel connection, the ⌘B grant mint, mic permission, iPad paint
 * clients, page selection pings) — same context fields, same code paths.
 */

import { render } from "@solidjs/web";
import { createIntentClient, type IntentLanes } from "../client";
import { fakeBus } from "../fake-bus";
import { keyVerdict } from "../keys";
import { Panel } from "./panel";

const bus = fakeBus({ activeTab: 1 });

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

let blipSink: ((key: string) => void) | undefined;

const client = createIntentClient({
  host: bus,
  lanes: consoleLanes,
  onBlip: (key) => blipSink?.(key),
  onDispatch: (event) => {
    if (event.changed.length > 0) {
      console.info(`[dispatch] ${event.command}`, event.changed.join(","), event.after);
    }
  },
});

// The dev page boots "connected" (the real page learns this from its bus).
client.setContext({ connected: true });

// The plain page stands in for the privileged ⌘B: grant the fake tab and
// open (the SW's invocation gate, simulated — same command path).
const grantAndOpen = (): void => {
  client.setContext({ grantedTab: bus.targeting.activeTab() });
  client.dispatch("cmdB");
};

// Document keys — the same verdicts the content-script forwarding uses.
const onKey = (phase: "down" | "up") => (event: KeyboardEvent) => {
  if (event.metaKey && event.key === "b") {
    event.preventDefault();
    grantAndOpen();
    return;
  }
  const verdict = keyVerdict(client.state(), event.key, phase, event.repeat);
  if (verdict.kind === "pass") {
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
  const toggle = (fn: () => void) => fn;
  return (
    <details style="margin: 12px 0 0 12px; font: 12px system-ui; opacity: 0.8" open>
      <summary>simulate (dev page stand-ins for real host facts)</summary>
      <div style="display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px">
        <button type="button" data-testid="cmd-b" onClick={grantAndOpen}>
          ⌘B — grant + open turn
        </button>
        <button
          type="button"
          onClick={toggle(() => client.setContext({ connected: !client.context().connected }))}
        >
          channel connect/drop
        </button>
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
      </div>
    </details>
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
    </>
  ),
  root,
);

// The page-level instrumentation hook (frontend-for-agents): the agent can
// drive and verify the panel from the console / devtools MCP.
(window as unknown as { __aiuiIntentClient?: unknown }).__aiuiIntentClient = { client, bus };
