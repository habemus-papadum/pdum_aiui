import { describe, expect, it } from "vitest";
import { LIVE_COMPOSER_INSTRUCTIONS, LIVE_NUDGE_TEXT } from "./live-session";

/**
 * The commit-gate drift guards (transcription-and-realtime-submodes.md §11): the
 * instructions are the ONE authoritative persona both engines send, and they must
 * quote the commit sentinel verbatim — the model is gated on the exact message
 * the channel injects at fin, so the two constants may never drift apart.
 */
describe("LIVE_COMPOSER_INSTRUCTIONS", () => {
  it("quotes the commit sentinel verbatim", () => {
    expect(LIVE_COMPOSER_INSTRUCTIONS).toContain(`"${LIVE_NUDGE_TEXT}"`);
  });

  it("states the gating discipline: only after the sentinel, never earlier", () => {
    expect(LIVE_COMPOSER_INSTRUCTIONS).toMatch(/ONLY after/);
    expect(LIVE_COMPOSER_INSTRUCTIONS).toMatch(/Never call it earlier/);
  });

  it("describes the co-composition situation, not a generic assistant", () => {
    expect(LIVE_COMPOSER_INSTRUCTIONS).toMatch(/jointly composing an instruction/);
    expect(LIVE_COMPOSER_INSTRUCTIONS).toMatch(/coding agent/);
    // The removed early trigger (a spoken "send it") must not creep back in.
    expect(LIVE_COMPOSER_INSTRUCTIONS).not.toMatch(/they say to send it/);
  });

  it("teaches the selection label grammar alongside the image one (F2)", () => {
    // Selections arrive as bracketed text items, same grammar family as
    // [image shot_N]; both id families are placeable in segments[].
    expect(LIVE_COMPOSER_INSTRUCTIONS).toContain("[image shot_3]");
    expect(LIVE_COMPOSER_INSTRUCTIONS).toContain("[selection sel_2");
    expect(LIVE_COMPOSER_INSTRUCTIONS).toContain('"sel_2"');
    expect(LIVE_COMPOSER_INSTRUCTIONS).toContain('"code_1"');
  });

  it("states the update and retraction semantics (reuse the id; disregard retracted)", () => {
    expect(LIVE_COMPOSER_INSTRUCTIONS).toMatch(/updated selection reuses its id/);
    expect(LIVE_COMPOSER_INSTRUCTIONS).toMatch(/retracted one must be disregarded/);
  });
});
