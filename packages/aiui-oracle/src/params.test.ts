/**
 * The params tables and the path access they address values through — the
 * pure half of the two knob-boards, testable without a DOM.
 *
 * The three decisions worth pinning: unset is a state distinct from a value,
 * switching turn-detection type must not carry the other algorithm's knobs,
 * and a row only "drifts" when we actually asked for something.
 */
import { describe, expect, it } from "vitest";
import {
  CONSTRAINT_PARAMS,
  getPath,
  groupSpecs,
  pruneTurnDetection,
  rowDrifts,
  SESSION_PARAMS,
  setPath,
  specApplies,
  TURN_DETECTION_TYPE,
} from "./params";
import type { OracleConfig } from "./types";

describe("path access", () => {
  it("reads through missing levels without throwing", () => {
    expect(getPath({ audio: { input: { threshold: 0.75 } } }, "audio.input.threshold")).toBe(0.75);
    expect(getPath({}, "audio.input.turn_detection.type")).toBeUndefined();
    expect(getPath(undefined, "a.b")).toBeUndefined();
  });

  it("creates objects on the way down, and DELETES on undefined", () => {
    const root: Record<string, unknown> = {};
    setPath(root, "audio.input.turn_detection.threshold", 0.75);
    expect(root).toEqual({ audio: { input: { turn_detection: { threshold: 0.75 } } } });

    // Unset is not the same as "sent as undefined": the vendor's default and
    // an explicit value are different states, so the key goes away entirely.
    setPath(root, "audio.input.turn_detection.threshold", undefined);
    expect(root).toEqual({ audio: { input: { turn_detection: {} } } });
    expect(
      Object.hasOwn(
        (((root.audio as Record<string, unknown>).input as Record<string, unknown>)
          .turn_detection ?? {}) as object,
        "threshold",
      ),
    ).toBe(false);
  });

  it("keeps null — it is the vendor's own spelling for off, not an absence", () => {
    const root: Record<string, unknown> = {};
    setPath(root, "audio.input.turn_detection", null);
    expect(root).toEqual({ audio: { input: { turn_detection: null } } });
  });
});

describe("switching turn_detection type", () => {
  const configWith = (detection: unknown): OracleConfig =>
    ({
      instructions: "x",
      audio: { input: { turn_detection: detection } },
    }) as OracleConfig;

  it("drops server_vad's knobs when moving to semantic_vad", () => {
    // `threshold` means nothing to the semantic classifier; carrying it over
    // would send a field the vendor must ignore, and the drift check would
    // then report a problem we invented.
    const config = configWith({
      type: "semantic_vad",
      threshold: 0.75,
      silence_duration_ms: 700,
      interrupt_response: false,
    });
    pruneTurnDetection(config);
    expect(config.audio?.input?.turn_detection).toEqual({
      type: "semantic_vad",
      interrupt_response: false,
    });
  });

  it("drops eagerness when moving back to server_vad, and keeps the shared pair", () => {
    const config = configWith({
      type: "server_vad",
      eagerness: "low",
      threshold: 0.75,
      create_response: true,
    });
    pruneTurnDetection(config);
    expect(config.audio?.input?.turn_detection).toEqual({
      type: "server_vad",
      create_response: true,
      threshold: 0.75,
    });
  });

  it("null collapses the whole object", () => {
    const config = configWith(null);
    pruneTurnDetection(config);
    expect(config.audio?.input?.turn_detection).toBeNull();
  });
});

describe("which rows apply", () => {
  const rowsFor = (config: unknown) =>
    SESSION_PARAMS.filter((spec) => specApplies(spec, config)).map((spec) => spec.name);

  it("shows server_vad's knobs when nothing is set — the engine's own default", () => {
    // The row must not vanish just because nobody has stated the type yet.
    const names = rowsFor({ instructions: "x" });
    expect(names).toContain("threshold");
    expect(names).toContain("silence_duration_ms");
    expect(names).not.toContain("eagerness");
  });

  it("swaps the two algorithms' knobs, keeping what they share", () => {
    const semantic = rowsFor({ audio: { input: { turn_detection: { type: "semantic_vad" } } } });
    expect(semantic).toContain("eagerness");
    expect(semantic).not.toContain("threshold");
    expect(semantic).toContain("interrupt_response");
    expect(semantic).toContain("create_response");
  });
});

describe("drift", () => {
  it("only counts a value we ASKED for and did not get", () => {
    expect(rowDrifts(0.75, 0.5)).toBe(true);
    expect(rowDrifts(0.75, 0.75)).toBe(false);
    // Unset against a server-side default is agreement, not conflict — the
    // opposite reading would light up every untouched row.
    expect(rowDrifts(undefined, 0.5)).toBe(false);
    // Nothing reported yet is not evidence of anything.
    expect(rowDrifts(0.75, undefined)).toBe(false);
  });
});

describe("the tables themselves", () => {
  it("address real, unique paths", () => {
    for (const table of [SESSION_PARAMS, CONSTRAINT_PARAMS]) {
      const paths = table.map((spec) => spec.path);
      expect(new Set(paths).size).toBe(paths.length);
      for (const spec of table) {
        expect(spec.path).not.toMatch(/(^\.|\.$|\.\.)/);
        expect(spec.hint).not.toBe("");
      }
    }
  });

  it("uses the VENDOR's spelling on both sides — the casing is the tell", () => {
    // Deliberately unharmonized: OpenAI's snake_case next to WebRTC's
    // camelCase. The label tells you which manual the word came from, so a
    // future tidy-up that "fixes" one of them would be a regression.
    expect(SESSION_PARAMS.some((spec) => spec.name === "silence_duration_ms")).toBe(true);
    expect(SESSION_PARAMS.some((spec) => spec.name === "eagerness")).toBe(true);
    expect(CONSTRAINT_PARAMS.some((spec) => spec.name === "echoCancellation")).toBe(true);
    expect(CONSTRAINT_PARAMS.some((spec) => spec.name === "autoGainControl")).toBe(true);
    // Nothing title-cased or re-spelled anywhere.
    for (const spec of [...SESSION_PARAMS, ...CONSTRAINT_PARAMS]) {
      expect(spec.name).not.toMatch(/^[A-Z]| /);
    }
    // The one row that is NOT a vendor field declares itself, and its group
    // says so in words. Nothing else may claim that scope.
    const ourRows = SESSION_PARAMS.filter((spec) => spec.scope === "aiui");
    expect(ourRows.map((spec) => spec.name)).toEqual(["parkAfterIdleSeconds"]);
    for (const spec of ourRows) {
      expect(spec.group).toContain("ours");
    }
  });

  it("every row names a group and a default — the two questions asked first", () => {
    for (const spec of [...SESSION_PARAMS, ...CONSTRAINT_PARAMS]) {
      expect(spec.group).not.toBe("");
      // "What is the default?" belongs in the tool, not in a chat log that
      // goes stale the moment the vendor changes one.
      expect(spec.default).toBeDefined();
    }
  });

  it("groups keep TABLE order, not alphabetical — the tables are tuning order", () => {
    const groups = groupSpecs(SESSION_PARAMS);
    expect(groups[0]?.name).toBe("turn_detection");
    expect(groups.map((group) => group.name)).toEqual([
      "turn_detection",
      "noise_reduction",
      "transcription",
      "audio.output",
      "session",
      // Ours, and visibly labelled as such — the verbatim-names rule would be
      // worthless if an aiui knob could pass itself off as a vendor field.
      "aiui — ours, not the vendor's",
    ]);
    expect(groupSpecs(CONSTRAINT_PARAMS).map((group) => group.name)).toEqual([
      "processing",
      "capture",
    ]);
  });

  it("marks the frozen fields as frozen", () => {
    // Keyed by PATH, not name: names are scoped by their group now, so
    // `model` is both `transcription.model` and the session's own.
    const when = (path: string) => SESSION_PARAMS.find((spec) => spec.path === path)?.when;
    expect(when("model")).toBe("connect");
    // Not connect-time: the vendor freezes voice once the model has SPOKEN.
    expect(when("audio.output.voice")).toBe("before-first-reply");
    expect(when(TURN_DETECTION_TYPE)).toBe("live");
  });
});
