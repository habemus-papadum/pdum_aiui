/**
 * config.ts — the standing config surface, pulled forward from Phase 2 so
 * the bar is feature-complete NOW and nothing gets lost (PARITY.md "kept
 * getting lost" list). Values, bounds, and options mirror the old panel's
 * store (aiui-extension panel/model/store.ts) verbatim; the lanes that READ
 * them (hello expansion, sampler cadence, pencil relay) bind in Phase 2.
 *
 * Every entry is a `control()` — durable, agent-visible through the standard
 * tools, and rendered in the bar/config strip as widget nodes bound by name.
 */

import { control } from "@habemus-papadum/aiui-viz";

/** Speech-to-text engine, by model name (read at thread-open — the hello). */
export const stt = control({
  name: "stt",
  value: "scribe-v2",
  options: ["scribe-v2", "gpt-realtime-whisper", "gpt-4o-transcribe", "gpt-4o-mini-transcribe"],
  description: "speech-to-text engine for talk",
});

/** The realtime prompt linter (orthogonal to stt; the hello carries it). */
export const linter = control({
  name: "linter",
  value: "off",
  options: ["off", "openai", "gemini"],
  description: "realtime prompt linter",
});

/** Constant mode's cadence, SECONDS PER FRAME (the slider under video). */
export const videoPeriodSec = control({
  name: "videoPeriodSec",
  value: 5,
  min: 1,
  max: 10,
  step: 0.1,
  unit: "s",
  description: "constant-mode video cadence, seconds per frame",
});

/** Vanishing pencil: off = strokes persist on the page (§13.6 default); on =
 * they fade over `pencilFade`. A standing config control (owner, 2026-07-16:
 * the on/off is the `pencil` mode region, vanish is this setting). */
export const pencilVanish = control({
  name: "pencilVanish",
  value: false,
  description: "pencil strokes fade out instead of persisting",
});

/** The pencil's vanishing lifetime, seconds — the fade slider (live re-relayed
 * while pencil is claimed). Only how LONG vanishing takes; the on/off is
 * `pencilVanish`. */
export const pencilFade = control({
  name: "pencilFade",
  value: 6,
  min: 2,
  max: 20,
  step: 0.1,
  unit: "s",
  description: "vanishing-pencil stroke lifetime",
});

/** Blue confirmation flash after a MANUAL shot (sampled frames never flash). */
export const shotFlash = control({
  name: "shotFlash",
  value: true,
  description: "flash the page on a manual shot",
});

/** Console log verbosity (quiet | info | debug). */
export const logLevel = control({
  name: "logLevel",
  value: "info",
  options: ["quiet", "info", "debug"],
  description: "console narration level",
});

/** Panel zoom — driven by the SIDE PANEL's own −/%/+ buttons (top-right corner;
 * ext/side-panel-zoom.tsx). Side panel only: the plain page has real browser
 * zoom. No keyboard shortcut, no bar widget (owner, 2026-07-16: buttons replaced
 * the ⌘-chord — a visible control beats a hidden one). */
export const uiScale = control({
  name: "uiScale",
  value: 1,
  min: 0.6,
  max: 2,
  step: 0.1,
  description: "panel zoom (keyboard only)",
});
