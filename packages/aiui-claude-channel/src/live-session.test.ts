/**
 * The linter persona is a LOAD-BEARING prompt (docs/guide/prompt-linting.md
 * publishes it verbatim) — these tests pin the teachings the sidecar's wire
 * behavior depends on, so an edit that drops one fails a named test instead
 * of silently degrading the lint.
 */
import { describe, expect, it } from "vitest";
import { LINTER_INSTRUCTIONS } from "./live-session";

describe("LINTER_INSTRUCTIONS", () => {
  it("teaches the label grammar: images, selections, AND the transcript item", () => {
    expect(LINTER_INSTRUCTIONS).toContain("[image shot_3]");
    expect(LINTER_INSTRUCTIONS).toContain("[selection sel_2");
    expect(LINTER_INSTRUCTIONS).toContain('[transcript seg_N: "…"]');
  });

  it("states the update and retraction semantics (reuse the id; disregard retracted)", () => {
    expect(LINTER_INSTRUCTIONS).toMatch(/updated selection reuses its id/i);
    expect(LINTER_INSTRUCTIONS).toMatch(/retracted one must be disregarded/i);
  });

  it("forbids composing: the model observes, the compiler assembles", () => {
    expect(LINTER_INSTRUCTIONS).toMatch(/never write or rewrite the briefing/i);
    expect(LINTER_INSTRUCTIONS).toMatch(/separate compiler assembles it verbatim/i);
    expect(LINTER_INSTRUCTIONS).toMatch(/never summarize/i);
    expect(LINTER_INSTRUCTIONS).toMatch(/never answer the task/i);
  });

  it("speaks only when asked, keeps it short, with a quiet default", () => {
    expect(LINTER_INSTRUCTIONS).toMatch(/speak ONLY when asked/);
    expect(LINTER_INSTRUCTIONS).toMatch(/few short spoken sentences/);
    expect(LINTER_INSTRUCTIONS).toContain('"clear so far"');
  });

  it("scopes read_file to verification, not browsing", () => {
    expect(LINTER_INSTRUCTIONS).toContain("read_file");
    expect(LINTER_INSTRUCTIONS).toMatch(/verify suspicions, don't browse/);
  });
});
