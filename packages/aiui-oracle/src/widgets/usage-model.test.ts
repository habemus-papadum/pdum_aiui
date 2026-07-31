/**
 * The usage strip's pure model — which chips exist and what they hold.
 *
 * The behaviour worth pinning is that the strip is a FIXED set: it is readable
 * from the moment the oracle is on, showing zeros, rather than materializing
 * chip by chip as each kind of token first appears.
 */
import { describe, expect, it } from "vitest";
import type { UsageTotals } from "../types";
import { usageChips } from "./usage";

const empty: UsageTotals = {
  inputTokens: 0,
  inputAudioTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  outputAudioTokens: 0,
  responses: 0,
  unpricedResponses: 0,
  approximateResponses: 0,
};

describe("the chips", () => {
  it("are all present at ZERO — nothing spent is a statement, not an absence", () => {
    // Filtering empties made the strip appear only once something had been
    // charged, and reflow as each kind arrived — so the number you were
    // watching kept moving. A fixed set is a stable target.
    const chips = usageChips(empty);
    expect(chips).toHaveLength(5);
    expect(chips.every((chip) => chip.count === 0)).toBe(true);
    expect(chips.map((chip) => chip.kind)).toEqual([
      "in-audio",
      "in-text",
      "cached",
      "out-audio",
      "out-text",
    ]);
  });

  it("derives text as total MINUS audio — the modality figures are subsets", () => {
    const chips = usageChips({
      ...empty,
      inputTokens: 5000,
      inputAudioTokens: 4000,
      cachedInputTokens: 3800,
      outputTokens: 500,
      outputAudioTokens: 450,
      responses: 1,
    });
    const count = (kind: string) => chips.find((chip) => chip.kind === kind)?.count;
    expect(count("in-audio")).toBe(4000);
    expect(count("in-text")).toBe(1000);
    expect(count("out-audio")).toBe(450);
    expect(count("out-text")).toBe(50);
    // Cached is a SUBSET of the input, not a fourth direction — it is not
    // subtracted from anything, and it is the one you want going up.
    expect(count("cached")).toBe(3800);
  });

  it("never renders a negative, however inconsistent the vendor's figures", () => {
    // A payload whose audio subset exceeds its own total would otherwise show
    // a negative text count — nonsense on a strip read at a glance.
    const chips = usageChips({ ...empty, inputTokens: 10, inputAudioTokens: 999, responses: 1 });
    expect(chips.find((chip) => chip.kind === "in-text")?.count).toBe(0);
  });

  it("encodes direction on the audio pair twice — the two that dominate the bill", () => {
    const chips = usageChips(empty);
    const icon = (kind: string) => chips.find((chip) => chip.kind === kind)?.icon;
    expect(icon("in-audio")).toBe("↑🎙");
    expect(icon("out-audio")).toBe("↓🔊");
    // Cached carries no arrow: it is a subset of the input, not a direction.
    expect(icon("cached")).toBe("⚡");
  });
});
