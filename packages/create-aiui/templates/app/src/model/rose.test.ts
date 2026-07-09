// <aiui-scenery-file> — this WHOLE FILE is placeholder scenery: delete it on reset (CLAUDE.md § Reset).
/**
 * rose.test.ts — the playbook's layer 1 in miniature: pure functions get the
 * cheapest, most exhaustive tests in the app. No framework, no owner, no
 * ticks — values in, assertions out. When you replace the rose with your real
 * domain math, give it a file like this first.
 */
import { describe, expect, it } from "vitest";
import { buildRose } from "./rose";

describe("buildRose (pure, layer 1)", () => {
  it("walks 361 points and closes the outline", () => {
    const rose = buildRose({ petals: 6, step: 71 });
    // 361 visited points → "M" + 360 "L" separators; the outline is closed.
    expect(rose.walk.startsWith("M")).toBe(true);
    expect(rose.walk.split("L")).toHaveLength(361);
    expect(rose.outline.endsWith("Z")).toBe(true);
  });

  it("is deterministic — same parameters, identical paths", () => {
    expect(buildRose({ petals: 4, step: 37 })).toEqual(buildRose({ petals: 4, step: 37 }));
  });

  it("responds to each parameter", () => {
    const base = buildRose({ petals: 6, step: 71 });
    expect(buildRose({ petals: 7, step: 71 }).walk).not.toBe(base.walk);
    expect(buildRose({ petals: 6, step: 72 }).walk).not.toBe(base.walk);
  });
});
