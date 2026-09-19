import { describe, expect, it } from "vitest";
import { backendToolsFromTools } from "./prompt";

describe("backendToolsFromTools", () => {
  it("derives the voice model's capability list from the tools and the brief's first sentence", () => {
    expect(
      backendToolsFromTools(
        [
          { name: "set_freq", description: "Set the frequency." },
          { name: "kick", description: "Add a phase impulse." },
        ],
        "A damped oscillator. It has a trace.",
      ),
    ).toBe(
      "- App: A damped oscillator.\n- set_freq: Set the frequency.\n- kick: Add a phase impulse.",
    );
    expect(backendToolsFromTools([])).toBeUndefined();
  });
});

import { backendPrompt, DELEGATION_CLOSING, livePrompt } from "./prompt";

describe("livePrompt", () => {
  it("weaves the vendor template in order", () => {
    const text = livePrompt({ app: "A wave app.", stance: "Be terse.", backendTools: "- control" });
    const order = [
      "You are the oracle",
      "About this app:",
      "For this conversation:",
      "Backchannel policy:",
      "Interruption policy:",
      "Delegation policy:",
      "Backend tools:",
      "- control",
      "Delegate to the backend when:",
      "Do not delegate to the backend when:",
      DELEGATION_CLOSING.split("\n")[0] as string,
    ];
    let last = -1;
    for (const needle of order) {
      const at = text.indexOf(needle);
      expect(at, needle).toBeGreaterThan(last);
      last = at;
    }
  });

  it("is deterministic and omits empty slots", () => {
    expect(livePrompt({})).toBe(livePrompt({ app: "  " }));
    expect(livePrompt({})).not.toContain("About this app");
  });

  it("builds the three-section backend prompt", () => {
    const text = backendPrompt({ app: "a wave visualizer", task: "Do the thing." });
    expect(text).toContain("## Voice conversation context");
    expect(text).toContain("about a wave visualizer");
    expect(text).toContain("## Task instructions\nDo the thing.");
    expect(text).toContain("## Return the result");
  });
});
