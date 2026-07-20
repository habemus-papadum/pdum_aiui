/**
 * trace-pane.tsx — the RICH trace viewer, embedded in the panel (owner,
 * 2026-07-14: embedded, not linked out — the side panel has the space now).
 *
 * This is the shared debug-ui `TracesPane` — the same surface `/__aiui/debug`
 * and `aiui dashboard` mount: the session-filtered trace list, follow-newest, and
 * the TraceView reading surface (status header, prompt hero with real shot
 * thumbnails, filter chips, coalesced stage cards). One implementation,
 * another home; nothing is forked.
 *
 * The embedding is a Solid ISLAND: debug-ui is deliberately framework-free
 * imperative DOM, so the component owns a host `<div>`, mounts the pane's
 * root into it, and drives the pane's lifecycle off Solid's — `activate()`
 * (which starts the list/follow polls) only while the disclosure is OPEN, so
 * a closed pane costs zero requests, and `deactivate()` + removal on
 * cleanup. The same doctrine as the preview's LiveDiffText islands: Solid
 * renders structure; the island owns its clock.
 *
 * Where the traces come from is the ONE thing that differs per tier, and it
 * is just a URL: the channel-served page polls its own origin; the extension
 * panel polls the discovered channel port (loopback fetch — host_permissions).
 */

import { TracesPane } from "@habemus-papadum/aiui-trace-ui";
import { createEffect, createSignal, onCleanup } from "solid-js";

export const TRACE_PANE_STYLES = `
  .aiui-rich-trace { margin: 8px 12px; font: 12px system-ui; }
  .aiui-rich-trace summary { cursor: pointer; opacity: 0.75; }
  /* The debug-ui pane is built for a full page; here it gets a bounded,
     scrolling window. Its root is a flex column, so height must be pinned. */
  .aiui-rich-trace-host { height: min(52vh, 480px); display: flex; flex-direction: column;
    overflow: hidden; margin-top: 4px; border: 1px solid color-mix(in srgb, currentColor 15%, transparent);
    border-radius: 6px; background: #14171f; }
`;

/**
 * The lowering-trace debugger, as a collapsible pane. `baseUrl` is the
 * channel to poll (`""` = same origin, the channel-served page's case).
 */
export function RichTracePane(props: { baseUrl: string }) {
  const [open, setOpen] = createSignal(false);
  const host = (<div class="aiui-rich-trace-host" />) as HTMLDivElement;
  const pane = new TracesPane({ baseUrl: props.baseUrl });
  host.append(pane.root);
  onCleanup(() => {
    pane.deactivate();
    pane.root.remove();
  });

  // Polls run only while the user is looking: open ⇒ activate (list +
  // follow timers), closed ⇒ deactivate. The effect handler is the
  // imperative edge; `open` is the tracked read.
  createEffect(
    () => open(),
    (isOpen) => {
      if (isOpen) {
        pane.activate();
      } else {
        pane.deactivate();
      }
    },
  );

  return (
    <details
      class="aiui-rich-trace"
      data-testid="rich-trace-pane"
      onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}
    >
      <summary>traces</summary>
      {host}
    </details>
  );
}
