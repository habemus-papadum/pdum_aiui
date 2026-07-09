import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { composeIntent } from "./engine";
import type { IntentEvent } from "./types";

/**
 * Replay the real interaction fixtures (recorded from live turns — see
 * ../../fixtures/README.md) through the moved
 * pipeline. This is the whole point of capturing them: they are the regression
 * net that catches a contract drifting silently (segments-as-lines, event
 * shapes, Option-C assembly). Assertions target stable structure/content, not
 * brittle full snapshots — `at` timestamps vary run to run.
 */

const fixturesDir = fileURLToPath(new URL("../../fixtures/", import.meta.url));

function load(name: string): IntentEvent[] {
  return JSON.parse(readFileSync(`${fixturesDir}${name}`, "utf8")) as IntentEvent[];
}

const files = readdirSync(fixturesDir)
  .filter((f) => f.endsWith(".json"))
  .sort();

describe("fixtures", () => {
  it("captured at least the five required interactions", () => {
    expect(files).toEqual([
      "cancel-turn.json",
      "dictation-typed-correction.json",
      "full-turn-send.json",
      "ink-and-region-shot.json",
      "plain-dictation.json",
    ]);
  });

  // Structural invariants that must hold for every captured stream.
  describe.each(files)("%s", (file) => {
    const events = load(file);

    it("is a non-empty stream of well-shaped events", () => {
      expect(events.length).toBeGreaterThan(0);
      for (const event of events) {
        expect(typeof event.at).toBe("number");
        expect(typeof event.type).toBe("string");
      }
    });

    it("composes without throwing and obeys segments-as-lines joining", () => {
      const composed = composeIntent(events, "replace");
      expect(typeof composed.prompt).toBe("string");
      // The transcript is the text runs joined by a single space — the same
      // by-space join the final prompt uses over the by-line patch document.
      const byLine = composed.items
        .filter((i) => i.kind === "text")
        .map((i) => i.text)
        .join(" ")
        .trim();
      expect(composed.transcript).toBe(byLine);
    });
  });
});

describe("plain-dictation.json", () => {
  const composed = composeIntent(load("plain-dictation.json"), "replace");

  it("is two clean text segments, joined, with no attachments", () => {
    expect(composed.items.map((i) => i.kind)).toEqual(["text", "text"]);
    expect(composed.transcript).toBe(
      "make the baseline curve a bit thicker and color it amber " +
        "the legend overlaps the plot on narrow screens can you move it below",
    );
    // No shots → the prompt is just the transcript (no marker tokens, no meta).
    expect(composed.prompt).toBe(composed.transcript);
    expect(composed.meta).toEqual({});
  });
});

describe("dictation-typed-correction.json", () => {
  const events = load("dictation-typed-correction.json");
  const composed = composeIntent(events, "replace");

  it("applies the typed correction as a patch (base line → baseline)", () => {
    const correction = events.find((e) => e.type === "correction");
    expect(correction).toMatchObject({ via: "typed", original: "base line" });
    // A real V4A patch rode along, not a plain replace.
    expect((correction as Extract<IntentEvent, { type: "correction" }>).patch).toContain(
      "*** Begin Patch",
    );
    expect(composed.corrections).toHaveLength(1);
    expect(composed.corrections[0].applied).toBe(true);
    expect(composed.transcript).toContain("baseline");
    expect(composed.transcript).not.toContain("base line");
  });
});

describe("ink-and-region-shot.json", () => {
  const composed = composeIntent(load("ink-and-region-shot.json"), "replace");

  it("carries a degraded shot: located components, no pixels, inline marker", () => {
    const shot = composed.items.find((i) => i.kind === "shot");
    expect(shot).toBeDefined();
    expect(shot?.path).toBeUndefined();
    expect(composed.components.length).toBeGreaterThan(0);
    // No saved file → degraded inline reference, element info kept in the text.
    expect(composed.prompt).toContain('<screenshot marker="shot_1" missing="image not captured"');
    expect(composed.meta).toEqual({});
  });
});

describe("full-turn-send.json", () => {
  const composed = composeIntent(load("full-turn-send.json"), "replace");

  it("interleaves text → shot → text with the marker in the body", () => {
    expect(composed.items.map((i) => i.kind)).toEqual(["text", "shot", "text"]);
    expect(composed.prompt).toContain("shot_1");
    // Both dictated segments survive, joined by space around the shot.
    expect(composed.transcript).toContain("make the baseline curve");
    expect(composed.transcript).toContain("the legend overlaps the plot");
  });
});

describe("cancel-turn.json", () => {
  const events = load("cancel-turn.json");

  it("ends in a cancel but still composes the dictated thread", () => {
    expect(events.at(-1)).toMatchObject({ type: "thread-close", reason: "cancel" });
    const composed = composeIntent(events, "replace");
    expect(composed.transcript.length).toBeGreaterThan(0);
  });
});
