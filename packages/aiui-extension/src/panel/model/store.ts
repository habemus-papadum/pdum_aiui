/**
 * store.ts — the panel's durable roots and its **control surface** (the
 * frontend-design methodology's layer-2 state side, extension-panel edition).
 *
 * `control()` declares the user-movable parameters ONCE — bounds validate
 * every write (widget, keyboard, agent alike), the aiui compiler injects the
 * name from the binding and lifts the doc comment as the description. State
 * that is standing-but-not-a-knob uses `durableSignal` (survives panel hot
 * swaps via the window registry; dies with the panel document, which is why
 * the turn mirror still exists).
 *
 * The §13.6 state machine's `phase` is deliberately NOT here: its truth is a
 * plain synchronous variable in main.tsx (`phaseNow`) because Solid defers
 * signal writes and the machine's guards run in the same synchronous flow as
 * engine events (CONTINUITY trap 2). Machines are imperative islands; the
 * store holds knobs and standing flags.
 *
 * Rarely edited; edits here full-reload the panel.
 */
import { control, durableSignal } from "@habemus-papadum/aiui-viz";

/**
 * Ink stroke fade lifetime in seconds — 0 (the default) keeps strokes until
 * they are cleared with C or a disarm (§13.6: those are the ONLY clears).
 * Matches the overlay's ✒️ permanent / 💨 vanishing chip semantics.
 */
export const inkFade = control({ value: 0, min: 0, max: 10, step: 1, unit: "s" });

/**
 * Blue confirmation flash after a manual shot. Share-sampled frames NEVER
 * flash regardless (§13.6 — periodic strobing is noise); this is the manual
 * shot's easy off-switch.
 */
export const shotFlash = control({ value: true });

/**
 * Ink MODE — the standing §13.6 flag (outlives turns; the pointer claim it
 * implies is per-turn). Survives panel hot swaps; dies with the document.
 */
export const inkMode = durableSignal("panel.inkMode", false);

/** Discovery refresh tick — the `rescan` action bumps it (internal, no knob). */
export const rescanTick = durableSignal("panel.rescanTick", 0);

/**
 * Console log verbosity — the routine-feedback channel (log.ts): "quiet"
 * silences it, "info" narrates state transitions and captures, "debug" adds
 * the chatty layer (blips, capture phases). Toasts stay the misuse channel
 * regardless of level.
 */
export const logLevel = control({ value: "info", options: ["quiet", "info", "debug"] });

/**
 * Transcription tier for talk (C5): rapid = streaming realtime (deltas →
 * the preview's diff animation), premium = word logprobs (confidence heat),
 * mock = offline. Read at thread-open (the hello carries the expansion).
 */
export const tier = control({ value: "rapid", options: ["mock", "rapid", "premium"] });

/** The realtime prompt linter (orthogonal to the tier; the hello carries it). */
export const linter = control({ value: "off", options: ["off", "openai", "gemini"] });

/** Periodic tab-frame sampling into the open turn (no flash — §13.6). */
export const videoOn = control({ value: false });

/** Sampling cadence: smart = only after page interaction; else frames/sec. */
export const videoFps = control({ value: "smart", options: ["smart", "0.5", "1", "2"] });

/**
 * Panel zoom — a multiplier on the BROWSER'S accessibility font-size default
 * (applied as a percentage root font-size; see index.html). Driven by
 * ⌘+/⌘−/⌘0 in the panel (deliberately no widget — decided 2026-07-12);
 * persisted in chrome.storage.local so it survives panel reopens.
 */
export const uiScale = control({ value: 1, min: 0.6, max: 2, step: 0.1 });
