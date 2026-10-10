import { rehydrate } from "@habemus-papadum/aiui-prompts";
import { describe, expect, it } from "vitest";
import { delegationRecord, laboratoryTools, markerSidecarRecord } from "./fixtures.ts";

describe("new synthetic compositions", () => {
  it("composes XML, Markdown, mathematics, and budgeted read/write tool groups", () => {
    const compiled = rehydrate(delegationRecord());
    const text = compiled.parts
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("");
    expect(text).toContain('<delegation backend="responses" id="synthetic-task-7"># Task');
    expect(text).toContain("Compare **run A** with **run B**");
    expect(text).toContain("energy &lt; 3.5 &amp; calibrated units");
    expect(text).toContain(String.raw`E = \frac{p^2}{2m}`);
    expect(text).toContain("Observations:\n- lab/read_run:");
    expect(text).toContain("Plans:\n- lab/set_plan:");
    expect(text).not.toContain("Supply the run identifier");
    expect(compiled.decisions).toContainEqual(
      expect.objectContaining({
        kind: "tool-budget",
        selected: "elided-usage",
        detail: expect.objectContaining({
          limit: 540,
          omittedUsage: ["lab/read_run"],
          snapshot: laboratoryTools.fingerprint,
        }),
      }),
    );
  });

  it("owns every emitted code unit and attributes escaped sidecar text to its capture", () => {
    const compiled = rehydrate(markerSidecarRecord());
    const text = compiled.parts[0];
    expect(text.type).toBe("text");
    if (text.type !== "text") throw new Error("Expected synthetic text output");
    expect(text.text).toContain('[current tab changed: tabId="synthetic-42" <tab');
    expect(text.text).toContain('url="https://example.invalid/laboratory?run=42&amp;view=summary"');
    expect(text.text).toContain(
      "Filter: energy &lt; 3.5 &amp; status = 'ready'</selection></tab>]",
    );
    let cursor = 0;
    for (const contribution of compiled.contributions.filter((item) => item.part === text.id)) {
      expect(contribution.start).toBe(cursor);
      expect(contribution.end).toBeGreaterThanOrEqual(cursor);
      expect(compiled.occurrences.some((owner) => owner.id === contribution.occurrence)).toBe(true);
      cursor = contribution.end as number;
    }
    expect(cursor).toBe(text.text.length);
    const captured = compiled.occurrences.find((item) => item.label === "Selection text");
    expect(captured?.origin).toMatchObject({
      eventId: "synthetic:tab-switch:42",
      captureRegion: "filter-panel",
    });
    const captureContribution = compiled.contributions.find(
      (item) => item.occurrence === captured?.id,
    );
    expect(captureContribution?.relation).toBe("escaped");
    expect(text.text.slice(captureContribution?.start, captureContribution?.end)).toBe(
      "Filter: energy &lt; 3.5 &amp; status = 'ready'",
    );
  });
});
