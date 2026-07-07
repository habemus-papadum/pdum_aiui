/**
 * ReaderPane.tsx — the disposable component that ADOPTS the durable Monaco
 * island. The editor DOM (`reader.container`) lives in the durable registry, so
 * a component hot-swap re-parents the same editor and the view state (cursor,
 * folds, scroll, the whole LSP session) survives. This is the demo's
 * `SimCanvas`/WebGL adoption pattern applied to Monaco.
 */
import { reader } from "../model/store";

export function ReaderPane() {
  return (
    <div
      class="reader-pane"
      ref={(el) => {
        // Adopt on mount; attach() re-parents the durable container and lays out.
        reader.attach(el as HTMLElement);
      }}
    />
  );
}
