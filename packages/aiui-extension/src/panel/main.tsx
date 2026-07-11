/**
 * The side panel — the per-window brain. Step 2: the Session pane is real
 * (channel discovery, bind, peers); the header chip reflects the binding.
 * Compose/Turn/Capture/Tools/Trace/Config arrive with their plan steps.
 */
import { injectPaneStyles, Pane, PaneStack, relayRequest } from "@habemus-papadum/aiui-webext";
import { render } from "@solidjs/web";
import { createSignal } from "solid-js";
import { SessionPane } from "./session-pane";

const PANEL_STYLES = `
  .hdr { display: flex; align-items: center; gap: 8px; margin: 2px 2px 10px; }
  .hdr .mark { color: #8ab4f8; font-weight: 700; }
  .hdr .win { margin-left: auto; color: #9aa4bd; font: 11px ui-monospace, monospace; }
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
  .row input {
    background: #0d0f15; color: #dfe3ec; border: 1px solid #2a3140;
    border-radius: 6px; padding: 3px 7px; font: 12px ui-monospace, monospace;
  }
  .row button, .peer { font: 12px ui-monospace, monospace; }
  .chan, .ghost {
    background: #232a3a; color: #dfe3ec; border: 1px solid #3a4460;
    border-radius: 6px; padding: 3px 8px; cursor: pointer;
  }
  .chan:disabled { background: #1d3a2a; border-color: #2f6b45; cursor: default; }
  .chan:hover:not(:disabled), .ghost:hover { background: #2d3650; }
  .peer { color: #cfd6e4; margin-top: 2px; }
  .peer .role {
    color: #8ab4f8; border: 1px solid #2a3140; border-radius: 4px;
    padding: 0 4px; margin-right: 4px; font-size: 10px;
  }
`;

function Panel() {
  const [windowId, setWindowId] = createSignal<number | undefined>();
  const [swPing, setSwPing] = createSignal("…");
  const [counter, setCounter] = createSignal(0);

  void chrome.windows.getCurrent().then((w) => setWindowId(w.id));
  relayRequest<{ at: string }>("sw", "ping")
    .then((r) => setSwPing(`service worker alive (${r.at.slice(11, 19)})`))
    .catch((e) => setSwPing(`service worker unreachable: ${String(e)}`));

  const session = SessionPane({ windowId });
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
        <span class={chipClass()}>
          <span class="dot" />
          {session.handle.port() !== undefined ? `:${session.handle.port()}` : "no channel"}
        </span>
        <span class="win">win {windowId() ?? "?"}</span>
      </div>
      <PaneStack>
        {session.view()}
        <Pane title="Dev" defaultOpen={false} hint="step 1">
          <div class="kv">{swPing()}</div>
          <div class="kv">
            HMR probe:{" "}
            <button type="button" class="ghost" onClick={() => setCounter((c) => c + 1)}>
              count {counter()}
            </button>{" "}
            — edit this pane, the count must survive.
          </div>
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
