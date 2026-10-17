/**
 * ink.ts — the ink specimen's surface: a `PencilSurface` over a durable ink
 * document (the strokes survive a hot edit; the surface, a view, is rebuilt).
 * Kept out of store.ts so the headless tests never construct a canvas; only
 * the ink specimen component imports this module.
 */

import { TOKENS } from "@habemus-papadum/aiui-design";
import { createInkDocument, inkSignals, PencilSurface, SKETCH } from "@habemus-papadum/aiui-pencil";
import { appScope, strokes } from "./store";

/** The document owns the ink; the surface fades it and expires faded records. */
export const inkDocument = appScope.durable("ink-document", () => createInkDocument());

/** The committed strokes and the live one, as signals (bounded rate). */
export const ink = inkSignals(inkDocument);

export const inkPad = new PencilSurface({
  document: inkDocument,
  className: "cat-ink-canvas",
  navigation: false,
  params: () => ({ ...SKETCH, size: 2.6, color: TOKENS.ink }),
  fadeSec: () => 8,
  expireFadedInk: true,
  background: () => undefined,
  onStrokeEnd: () => strokes.set((n) => n + 1),
});

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    ink.dispose();
    inkPad.dispose();
  });
}
