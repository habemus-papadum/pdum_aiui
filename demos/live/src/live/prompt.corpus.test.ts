/**
 * The CORPUS of this demo's authored live prompts — the three slot sets woven
 * by the library — as readable files under ../../corpus/. A baseline for the
 * prompt-toolkit migration, not a contract. `vitest -u` updates; review the diff.
 */

import { livePrompt } from "@habemus-papadum/aiui-live";
import { describe, expect, it } from "vitest";
import { BACKENDS_SLOTS, LIVE_SLOTS, WIRE_SLOTS } from "./prompt";

// Vitest provides __dirname to test modules; this demo's tsconfig has no Node types.
declare const __dirname: string;
const corpus = (name: string): string => `${__dirname}/../../corpus/${name}`;

describe("corpus: the live demo's prompts", () => {
  it("the three authored slot sets, woven", async () => {
    await expect(livePrompt(LIVE_SLOTS)).toMatchFileSnapshot(corpus("live-slots.txt"));
    await expect(livePrompt(WIRE_SLOTS)).toMatchFileSnapshot(corpus("wire-slots.txt"));
    await expect(livePrompt(BACKENDS_SLOTS)).toMatchFileSnapshot(corpus("backends-slots.txt"));
  });
});
