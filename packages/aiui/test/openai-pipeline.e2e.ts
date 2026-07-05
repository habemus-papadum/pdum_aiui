/**
 * Micro-e2e for the intent pipeline's REAL OpenAI path.
 *
 * The unit tests mock every model call; this one tier exercises the actual
 * OpenAI API — but with near-zero tokens and asserting round-trip **shape**,
 * never output quality:
 *
 *  (a) transcription — one ~2 s checked-in WAV (generated locally with macOS
 *      `say` + `afconvert`; CI runners are Linux, so the fixture is committed,
 *      never generated in CI) POSTed to `/v1/audio/transcriptions`. Asserts a
 *      200 and non-empty text; records the latency.
 *  (b) correction diff — the workbench's V4A correction prompt sent to
 *      `/v1/chat/completions`, asserting the returned patch **parses and
 *      applies** via the workbench patch applier. Not that it's the *right*
 *      edit — only that the round trip yields an applicable V4A patch.
 *
 * Marker: `*.e2e.ts`, so `pnpm test` never collects it; it runs via
 * `pnpm test:e2e` (see vitest.e2e.config.ts) and, in CI, the weekly
 * openai-e2e.yml. Gated on `OPENAI_API_KEY`: with no key the whole suite skips
 * (describe.skipIf), so forks and offline runs stay green. Quality, latency
 * curves and model comparisons stay in the workbench's bench/corpus runner —
 * this is only a "the wire still works" smoke.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// Imported from the workbench source directly. These move to
// @habemus-papadum/aiui-dev-overlay/intent-pipeline when P1 of the graduation
// plan lands (see multimodal-intent-graduation.md); update the path then.
import { SYSTEM_PROMPT } from "../../aiui-dev-overlay/workbench/src/correct";
import { applyPatch } from "../../aiui-dev-overlay/workbench/src/patch";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// The models the workbench settled on as defaults (openai-audio-stack.md,
// field-notes.md): mini transcribe for STT, mini chat at temperature 0 for the
// correction diff. Cheapest tokens that still exercise the real request shape.
const TRANSCRIBE_MODEL = "gpt-4o-mini-transcribe";
const CORRECT_MODEL = "gpt-4o-mini";

const wavPath = new URL("./fixtures/segment.wav", import.meta.url);

describe.skipIf(!OPENAI_API_KEY)("openai intent pipeline · real round-trip (e2e)", () => {
  it("transcribes a short WAV: 200 + non-empty text", async () => {
    const bytes = readFileSync(wavPath);
    const form = new FormData();
    form.append("model", TRANSCRIBE_MODEL);
    // The filename EXTENSION is load-bearing: OpenAI sniffs the container by
    // name, not content-type (workbench field-notes). ".wav" must match the file.
    form.append("file", new File([bytes], "segment.wav", { type: "audio/wav" }));

    const started = performance.now();
    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { authorization: `Bearer ${OPENAI_API_KEY}` },
      body: form,
    });
    const latencyMs = Math.round(performance.now() - started);

    expect(res.ok).toBe(true);
    const payload = (await res.json()) as { text?: string };
    expect(typeof payload.text).toBe("string");
    expect((payload.text ?? "").trim().length).toBeGreaterThan(0);
    console.log(`[e2e] transcription (${TRANSCRIBE_MODEL}): ${latencyMs}ms → ${payload.text}`);
  });

  it("returns a correction diff that parses and applies as a V4A patch", async () => {
    // Segments-as-lines is the corrector's document contract (field-notes).
    const docLines = [
      "make the baseline curb a bit thicker and color it amber",
      "the legend overlaps the plot on narrow screens can you move it below",
    ];
    const selected = "curb";
    const instruction = "curve"; // replacement mode: verbatim content for the span

    const started = performance.now();
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${OPENAI_API_KEY}`,
        "content-type": "application/json",
      },
      // Mirrors workbench/src/correct.ts openaiCorrector: same SYSTEM_PROMPT,
      // same user framing (TRANSCRIPT / SELECTED / INSTRUCTION), temperature 0.
      body: JSON.stringify({
        model: CORRECT_MODEL,
        temperature: 0,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: `TRANSCRIPT:\n${docLines.join("\n")}\n\nSELECTED: ${JSON.stringify(
              selected,
            )}\n\nINSTRUCTION: ${JSON.stringify(instruction)}`,
          },
        ],
      }),
    });
    const latencyMs = Math.round(performance.now() - started);

    expect(res.ok).toBe(true);
    const payload = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = payload.choices?.[0]?.message?.content ?? "";
    expect(content).toContain("*** Begin Patch");

    // The parser IS the assertion: applyPatch parses the V4A grammar and
    // context-anchors the hunks, throwing on anything malformed or unmatchable.
    // A clean apply that changes the document proves an applicable patch came
    // back — shape, not quality.
    const applied = applyPatch(docLines, content);
    expect(applied).not.toEqual(docLines);
    console.log(`[e2e] correction (${CORRECT_MODEL}): ${latencyMs}ms → ${JSON.stringify(applied)}`);
  });
});
