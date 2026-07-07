/**
 * store.ts — the durable roots of the reader.
 *
 * Everything here survives a hot edit (the durable registry lives on `window`).
 * The reader island (Monaco + models + view state + LSP client + nav history)
 * is the big one; the active walkthrough is durable too, so iterating on the
 * stepper UI doesn't lose your place in a tour. The cell graph (graph.ts) and
 * the components (ui/) are the disposable logic edited constantly.
 *
 * Editing THIS file forces a full reload (it is a direct dependency of the
 * durable roots) — same rule as the demo's store.ts.
 */

import type { Walkthrough } from "@habemus-papadum/aiui-code-protocol";
import { durable } from "@habemus-papadum/aiui-viz";
import { type Accessor, createSignal, type Setter } from "solid-js";
import { type CodeReader, createReader } from "./reader";

export const reader: CodeReader = durable("code-reader/reader", createReader);

function signalBox<T>(
  key: string,
  // biome-ignore lint/complexity/noBannedTypes: mirrors createSignal's Exclude<T, Function> overload
  initial: Exclude<T, Function>,
): { get: Accessor<T>; set: Setter<T> } {
  return durable(key, () => {
    const [get, set] = createSignal<T>(initial);
    return { get, set };
  });
}

// --- walkthrough (Tier 3) durable state -------------------------------------

/** The tour currently being walked, if any. */
export const activeWalkthrough = signalBox<Walkthrough | undefined>(
  "code-reader/walkthrough",
  undefined,
);
/** Which step of {@link activeWalkthrough} is showing. */
export const walkthroughStep = signalBox<number>("code-reader/walkthrough-step", 0);
