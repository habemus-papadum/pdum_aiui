/**
 * @habemus-papadum/aiui-oscillator — a damped-oscillator SLICE: a reusable
 * control-surface + cell factory, and the worked example of the aiui
 * composability model (scopes, slice factories, cross-package identity).
 * Internal to the pdum_aiui repo; never published. The consuming demo is
 * `demos/twins`; the methodology write-up is the user guide's
 * "Composing bigger apps" section.
 */
export type { OscillatorParams } from "./oscillator";
export { displacementAt, oscillatorTrace } from "./oscillator";
export type { OscillatorCells, OscillatorStore } from "./slice";
export {
  oscillatorCells,
  oscillatorStore,
  TRACE_SAMPLES,
  TRACE_SECONDS,
} from "./slice";
