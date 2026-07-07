/**
 * mount.tsx — the embeddable entry. `main.tsx` renders the reader as a
 * standalone page; a host (the dev overlay's reader window) calls
 * `mountCodeReader(el)` instead and gets back a {@link CodeReaderInstance} whose
 * `.reader` it can wire to the session bus (selection out, reveal in). Same app,
 * two host contexts.
 */
import { render } from "@solidjs/web";
import "./styles.css";
import { setBackendOrigin } from "./model/backend-origin";
import "./model/graph"; // builds the cell graph + registers agent tools
import type { CodeReader } from "./model/reader";
import { reader } from "./model/store";
import { App } from "./ui/App";
import { initSystemTheme } from "./ui/theme";

export interface MountCodeReaderOptions {
  /**
   * Force the backend origin. The standalone harness passes `location.origin`
   * (it mounts the backend on its own dev server); when omitted, the reader
   * talks to `window.__AIUI__.port` (the channel), falling back to same-origin.
   */
  backendOrigin?: string;
}

export interface CodeReaderInstance {
  /** The live reader model: `selection()`, `currentFile()`, `reveal(range)`, … */
  readonly reader: CodeReader;
  /** Unmount the reader and release its Solid root. */
  dispose(): void;
}

/** Render the reader into `el`; returns the live model + a disposer. */
export function mountCodeReader(
  el: HTMLElement,
  opts?: MountCodeReaderOptions,
): CodeReaderInstance {
  if (opts?.backendOrigin !== undefined) {
    setBackendOrigin(opts.backendOrigin);
  }
  initSystemTheme();
  const dispose = render(() => <App />, el);
  return { reader, dispose };
}
