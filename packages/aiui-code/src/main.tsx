/**
 * main.tsx — the standalone harness entry. It drives the reader through the same
 * public seam a host uses ({@link mountCodeReader}), pinning the backend to this
 * dev server's own origin (the harness mounts the backend here via
 * `aiuiCodeBackendPlugin`, not on a channel).
 *
 * Durable roots (Monaco + models + the LSP client) live in model/store.ts, the
 * cell graph over them in model/graph.ts, the disposable SolidJS chrome in ui/ —
 * all set up inside mountCodeReader.
 */
import { mountCodeReader } from "./mount";

mountCodeReader(document.getElementById("root") as HTMLElement, {
  backendOrigin: window.location.origin,
});
