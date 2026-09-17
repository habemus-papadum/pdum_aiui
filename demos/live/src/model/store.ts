/**
 * store.ts — the durable roots: ONE oscillator slice under this app's
 * scope (the reusable slice from demos/oscillator), plus a control the
 * slice does not have — how many SAMPLES the trace is drawn with. That
 * knob is the demo's trap: at 24 samples a 5 Hz trace over 4 seconds
 * shows one point per cycle and the "wave" is a jagged lie. "Why does it
 * look jagged?" is a question only a backend that reads graph.ts can answer.
 */

import { oscillatorStore } from "@habemus-papadum/aiui-oscillator";
import { control, scope } from "@habemus-papadum/aiui-viz";

export const appScope = scope("live");

export const osc = oscillatorStore(appScope);

/** How many points the 4-second trace is sampled at (the render density). */
export const samples = control({ scope: appScope, value: 256, min: 8, max: 1024, step: 8 });
