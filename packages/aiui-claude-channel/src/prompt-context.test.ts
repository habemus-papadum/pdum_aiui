/**
 * The preamble's CDP-alignment sentence (hello `meta.cdp` → warn/affirm the
 * agent about its Chrome DevTools MCP): one row per verdict, plus the
 * silences — an absent/unknown verdict must never produce false comfort.
 */

import { describe, expect, it } from "vitest";
import {
  CDP_ALIGNED_NOTE,
  CDP_MISALIGNED_NOTE,
  CDP_NO_BROWSER_NOTE,
  cdpAlignmentNote,
  cdpSharedNote,
  promptContextSections,
} from "./prompt-context";

describe("cdpAlignmentNote", () => {
  it("aligned → the affirmation (the agent should use its DevTools MCP without fear)", () => {
    expect(cdpAlignmentNote({ state: "aligned", boundPort: 4100 })).toBe(CDP_ALIGNED_NOTE);
  });

  it("driven-by-other → the warning, naming the drivers", () => {
    const note = cdpAlignmentNote({
      state: "driven-by-other",
      boundPort: 4100,
      coDrivers: [{ port: 4200, label: "pdum_aiui :4200" }],
    });
    expect(note).toContain(CDP_MISALIGNED_NOTE);
    expect(note).toContain("pdum_aiui :4200");
  });

  it("aligned + co-drivers → the affirmation PLUS the parallel-agents heads-up", () => {
    const coDrivers = [{ port: 4200, label: "pdum_aiui :4200" }, { port: 4300 }];
    const note = cdpAlignmentNote({ state: "aligned", boundPort: 4100, coDrivers });
    expect(note).toContain(CDP_ALIGNED_NOTE);
    expect(note).toContain(cdpSharedNote(coDrivers));
    expect(note).toContain("2 other aiui channels are driving this same browser");
    expect(note).toContain("pdum_aiui :4200, :4300");
  });

  it("channel-drives-other → the plain warning", () => {
    expect(cdpAlignmentNote({ state: "channel-drives-other", boundPort: 4100 })).toBe(
      CDP_MISALIGNED_NOTE,
    );
  });

  it("channel-no-cdp → the no-browser note", () => {
    expect(cdpAlignmentNote({ state: "channel-no-cdp" })).toBe(CDP_NO_BROWSER_NOTE);
  });

  it("unknown / absent / unrecognized → silence (no false comfort)", () => {
    expect(cdpAlignmentNote({ state: "unknown" })).toBeUndefined();
    expect(cdpAlignmentNote(undefined)).toBeUndefined();
    expect(cdpAlignmentNote({ state: "something-newer" })).toBeUndefined();
  });
});

describe("promptContextSections carries the alignment sentence", () => {
  it("appends the warning after the tab marker when the hello declares a mismatch", () => {
    const sections = promptContextSections({
      tab: { url: "http://app.example/", title: "app" },
      cdp: { state: "channel-drives-other", boundPort: 4100 },
    });
    expect(sections.at(-1)).toBe(CDP_MISALIGNED_NOTE);
    expect(sections[0]).toContain("aiui intent tool");
  });

  it("says nothing extra when the hello has no verdict (older clients unchanged)", () => {
    const sections = promptContextSections({ tab: { url: "http://app.example/" } });
    expect(sections.some((s) => s.includes("Browser tooling"))).toBe(false);
  });
});
