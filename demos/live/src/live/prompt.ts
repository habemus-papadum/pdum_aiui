/**
 * prompt.ts — the words: what the voice model is told about this app, and
 * what the backend is told. Plain TypeScript (no Solid) so the Vite config,
 * the headless script, and the pages all share ONE description.
 */

import type { LivePromptSlots } from "@habemus-papadum/aiui-live";

export const APP_BLURB =
  "a damped-oscillator visualizer: one trace x(t) = A · e^(−ζωt) · cos(ωt + φ) drawn over a " +
  "4-second window, with controls for frequency (Hz), damping ratio ζ, amplitude, and the " +
  "number of samples the trace is drawn with; a kick action adds a quarter-turn phase impulse.";

export const LIVE_SLOTS: LivePromptSlots = {
  app: `This app is ${APP_BLURB}`,
  backendTools: `- App control: read the oscillator's settings (frequency, damping, amplitude, samples) and change them; kick it.
- Analysis: read the app's source code to explain how the trace is computed and why it looks the way it does; this can take a while, sometimes a minute.`,
  delegateWhen: `- The user asks to change a setting, kick the oscillator, or asks what a setting currently is.
- The user asks why the trace looks some way (jagged, flat, fast), or anything about how the app works inside.`,
  dontDelegateWhen: `- The user greets you, thanks you, or asks you to repeat something you already said.
- The user is thinking aloud and has not asked for anything.`,
};

/** The wire lab has no app: a bare persona and a delegate-everything policy. */
export const WIRE_SLOTS: LivePromptSlots = {
  app: "This is a bench for measuring the voice connection itself. There is a backend that answers every request; its answers are canned.",
  backendTools: "- A stand-in backend that answers anything after a fixed delay.",
  delegateWhen: "- The user asks for anything at all, or says a number, or asks a question.",
  dontDelegateWhen: "- The user only greets you.",
};

/** The backends bench: three toy tools, so a backend has something to call. */
export const BACKENDS_SLOTS: LivePromptSlots = {
  app: "This is a bench for comparing reasoning backends. The backend has a clock, a calculator, and a deliberately slow lookup.",
  backendTools: `- clock: the current time.
- add: add two numbers.
- slow_lookup: look something up in a slow archive (takes as long as the user asks, in seconds).`,
  delegateWhen:
    "- The user asks the time, asks for arithmetic, asks to look something up, or asks anything factual.",
  dontDelegateWhen: "- The user only greets you or thanks you.",
};
