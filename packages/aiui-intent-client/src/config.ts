/**
 * config.ts — the standing config surface (the parity ledger's "kept getting lost"
 * list). Values, bounds, and options carried over verbatim from the retired
 * extension panel's store (git history: aiui-extension); the lanes READ them
 * live — lanes.ts binds the hello expansion, the sampler cadence, and the
 * pencil relay.
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

/** The video cadence, SECONDS PER FRAME (the slider under video). Constant
 * mode reads it as the fixed clock; smart mode as the frame rate while the
 * page is ACTIVE (a quiet page sends nothing — capture-lanes' gate). */
export const videoPeriodSec = control({
  name: "videoPeriodSec",
  value: 5,
  min: 1,
  max: 10,
  step: 0.1,
  unit: "s",
  description: "video cadence, seconds per frame (smart mode: while the page is active)",
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

/**
 * Hand the ORACLE the driven page's own tools (O3b): while on, the tools the
 * tab in view registers at `window.__AIUI__.tools` are projected onto the live
 * session and re-projected whenever they change — so the oracle can DRIVE the
 * app you are building, not just talk about it. Off leaves it conversational.
 *
 * A config control rather than a cap, alongside stt/linter: it is a standing
 * setting, agent-visible, and the first of the proposal's three tool groups
 * (page · panel · files).
 */
export const oraclePageTools = control({
  name: "oraclePageTools",
  value: true,
  description: "give the oracle the tools of the page in view",
});

/** The oracle's second group (O3c): the panel's own command bar, readable and
 * pressable. The caps it may press are declared per-cap (`oracle: true` in
 * caps.ts), so this toggle is the coarse on/off, not the permission. */
export const oraclePanelTools = control({
  name: "oraclePanelTools",
  value: true,
  description: "let the oracle read and press the panel's own controls",
});

/** The oracle's third group (O3c): read_file · list_files · grep, executed
 * channel-side. Off by default — reading a project's source is a bigger step
 * than driving its UI, and it should be a deliberate one. */
export const oracleFileTools = control({
  name: "oracleFileTools",
  value: false,
  description: "let the oracle read and search the project's files",
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
  description: "panel zoom (side panel's −/%/+ buttons)",
});
