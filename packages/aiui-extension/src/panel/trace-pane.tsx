/**
 * The Trace pane — the shared lowering-trace debugger (`aiui-dev-overlay`'s
 * debug-ui `TracesPane`: the trace list, session-filtered, over a
 * live-followed TraceView) embedded in the panel, pinned to the BOUND channel
 * (Phase C8-lite; the overlay's 🔍 opens the same surface at /__aiui/debug).
 *
 * Lifecycle: the instance is (re)built per bound port and only POLLS while
 * the pane is expanded (Pane's onToggle drives activate/deactivate — the
 * list poll is 2s against loopback, cheap, but no reason to poll a collapsed
 * pane). Collapsed-but-bound keeps the DOM (Pane children stay mounted).
 */
import { TracesPane } from "@habemus-papadum/aiui-dev-overlay/debug-ui";
import { Pane } from "@habemus-papadum/aiui-webext";
import { createEffect, createSignal } from "solid-js";
import type { SessionHandle } from "./session";

export function TracePane(props: { session: SessionHandle }) {
  const [open, setOpen] = createSignal(false);
  let host: HTMLDivElement | undefined;
  let pane: TracesPane | undefined;

  createEffect(
    () => ({ port: props.session.port(), isOpen: open() }),
    ({ port, isOpen }) => {
      if (port === undefined || host === undefined) {
        return;
      }
      if (pane === undefined) {
        pane = new TracesPane({ baseUrl: `http://127.0.0.1:${port}` });
        host.append(pane.root);
      }
      if (isOpen) {
        pane.activate();
      } else {
        pane.deactivate();
      }
      // Port change / unbind: tear the instance down (a fresh one binds to
      // the next port); plain collapse only paused the polling above.
      return () => {
        if (props.session.port() !== port && pane !== undefined) {
          pane.deactivate();
          pane.root.remove();
          pane = undefined;
        }
      };
    },
  );

  return (
    <Pane title="Trace" defaultOpen={false} hint="lowering debugger" onToggle={setOpen}>
      <div
        class="trace-host"
        ref={(el: HTMLDivElement) => {
          host = el;
        }}
      />
    </Pane>
  );
}
