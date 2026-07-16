/**
 * side-panel-zoom.ts — panel zoom, EXTENSION SIDE PANEL ONLY (owner, 2026-07-16).
 *
 * Why it lives here and not in the shared shell: the plain page the channel
 * serves has real browser zoom (⌘+/⌘−/⌘0 just work), so it needs none of this.
 * The MV3 side panel is the opposite — browser zoom does NOT reach a side panel,
 * and Chrome swallows ⌘+/⌘−/⌘0 as its own accelerators before the panel document
 * ever sees the keydown. The old binding lived in the shared `installPanelKeys`
 * on ⌘=/⌘−/⌘0 and so did nothing in the side panel; worse, its one shifted
 * branch matched only "+" (⌘⇧=) and never its partner, because a shifted "-" is
 * "_" not "-", so zoom-OUT silently failed even when zoom-in happened to fire.
 *
 * So the side panel runs its OWN zoom on a chord the browser does NOT reserve:
 *   ⌘⇧+  larger   ·   ⌘⇧−  smaller   ·   ⌘⇧0  reset
 * Matched by `event.code` (the physical key: Equal / Minus / Digit0), so it is
 * keyboard-layout independent and immune to shift remapping the character.
 *
 * Two halves, both here: the KEY handler (steps the `uiScale` control — which
 * clamps to [min,max] and snaps to the step itself) and the APPLY effect
 * (`installUiScaleRoot`: uiScale → root font-size), so a scale restored at boot
 * lands on the document. Returns the combined uninstaller.
 */

import { uiScale } from "../config";
import { installUiScaleRoot } from "../ui/shell";

export function installSidePanelZoom(doc: Document = document): () => void {
  const disposeRoot = installUiScaleRoot(doc);

  const onKey = (event: KeyboardEvent): void => {
    // The browser owns ⌘+/⌘−/⌘0 (no shift); ours is strictly the ⌘⇧ chord, which
    // it does not, so it reaches us here — the whole point of requiring shift.
    if (!event.metaKey || !event.shiftKey) {
      return;
    }
    // Step through the UPDATER form, never get()+set(): Solid stages writes until
    // the next tick, so reading the value would make a fast double-press compute
    // both steps off the same stale scale (control.ts documents this exactly).
    // The control clamps to [min,max] and snaps to the step for us.
    if (event.code === "Equal") {
      event.preventDefault(); // ⌘⇧+ (the =/+ key) — larger
      uiScale.set(((prev: number) => prev + 0.1) as never);
    } else if (event.code === "Minus") {
      event.preventDefault(); // ⌘⇧− (the -/_ key) — smaller
      uiScale.set(((prev: number) => prev - 0.1) as never);
    } else if (event.code === "Digit0") {
      event.preventDefault(); // ⌘⇧0 — reset to 100%
      uiScale.set(1 as never);
    }
  };

  doc.addEventListener("keydown", onKey, true);
  return () => {
    doc.removeEventListener("keydown", onKey, true);
    disposeRoot();
  };
}
