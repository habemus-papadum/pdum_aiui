/**
 * reader/index.ts — the bootstrap the overlay-served code reader page runs.
 *
 * The reader is one *view* of the aiui session (the app tab is another). This
 * module boots it as a `"code"`-role session peer, mounts the Monaco reader, and
 * renders the disposable {@link SessionPanel} wired to the reader's live model.
 */
import { mountCodeReader } from "@habemus-papadum/aiui-code";
import { createComponent, render } from "@solidjs/web";
import { installSessionBus } from "../session-bus";
import { SessionPanel } from "./SessionPanel";
import "./session-panel.css";

export interface MountReaderPageOptions {
  /** Channel port; defaults to the plugin-injected window.__AIUI__.port. */
  port?: number;
}

/**
 * Boot the code reader as a session peer. Installs the "code"-role session bus,
 * mounts the reader into #aiui-code-root, and renders the SessionPanel wired to
 * the reader's live model. The reader talks to its backend (the channel's code
 * sidecar) via window.__AIUI__.port — mountCodeReader resolves that by default.
 */
export function mountReaderPage(opts: MountReaderPageOptions = {}): void {
  installSessionBus({ role: "code", ...(opts.port === undefined ? {} : { port: opts.port }) });
  let host = document.getElementById("aiui-code-root");
  if (!host) {
    host = document.createElement("div");
    host.id = "aiui-code-root";
    host.style.position = "fixed";
    host.style.inset = "0";
    document.body.appendChild(host);
  }
  const { reader } = mountCodeReader(host);
  const panelHost = document.createElement("div");
  document.body.appendChild(panelHost);
  // This entry is a `.ts` module (the package exports `./reader` at index.ts), so
  // it can't hold JSX; `createComponent(SessionPanel, { reader })` is exactly what
  // `<SessionPanel reader={reader} />` lowers to under the Solid transform.
  render(() => createComponent(SessionPanel, { reader }), panelHost);
}
