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
 *  (b) correction diff — the overlay's V4A correction prompt sent to
 *      `/v1/chat/completions`, asserting the returned patch **parses and
 *      applies** via the overlay's patch applier. Not that it's the *right*
 *      edit — only that the round trip yields an applicable V4A patch.
 *
 * Marker: `*.e2e.ts`, so `pnpm test` never collects it; it runs via
 * `pnpm test:e2e` (see vitest.e2e.config.ts) and, in CI, the weekly
 * openai-e2e.yml. Gated on `OPENAI_API_KEY`: with no key the whole suite skips
 * (describe.skipIf), so forks and offline runs stay green. Quality, latency
 * curves and model comparisons were measured in the retired workbench lab —
 * this is only a "the wire still works" smoke.
 */
import { readFileSync } from "node:fs";
import { openaiSpeaker, SYSTEM_PROMPT } from "@habemus-papadum/aiui-claude-channel";
import { describe, expect, it } from "vitest";
// The correction prompt + V4A applier graduated from the retired workbench lab into the
// shared packages (multimodal-intent-graduation.md P1): the SYSTEM_PROMPT is
// re-exported by the channel's corrector seam (a dependency here); `applyPatch`
// graduated to the intent-pipeline core — imported by relative source path since
// aiui-dev-overlay is not a dependency of this package (as an overlay import
// was before).
import { applyPatch } from "../../aiui-dev-overlay/src/intent-pipeline/patch";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// The models the workbench lab settled on as defaults (archive/workbench/openai-audio-stack.md,
// field-notes.md): mini transcribe for STT, mini chat at temperature 0 for the
// correction diff. Cheapest tokens that still exercise the real request shape.
const TRANSCRIBE_MODEL = "gpt-4o-mini-transcribe";
const CORRECT_MODEL = "gpt-4o-mini";
// The premium tier's TTS-ack model (model-tiers.md T2). A one-word ack is a few KB.
const TTS_MODEL = "gpt-4o-mini-tts";

const wavPath = new URL("./fixtures/segment.wav", import.meta.url);

describe.skipIf(!OPENAI_API_KEY)("openai intent pipeline · real round-trip (e2e)", () => {
  it("transcribes a short WAV: 200 + non-empty text", async () => {
    const bytes = readFileSync(wavPath);
    const form = new FormData();
    form.append("model", TRANSCRIBE_MODEL);
    // The filename EXTENSION is load-bearing: OpenAI sniffs the container by
    // name, not content-type (archive/workbench/field-notes.md). ".wav" must match the file.
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
      // Mirrors the retired lab's openaiCorrector: same SYSTEM_PROMPT,
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

  it("synthesizes a short TTS ack: non-empty audio + a MIME (premium tier)", async () => {
    // The production speaker seam (the premium tier's audioBack:"acks" path).
    const started = performance.now();
    const result = await openaiSpeaker({
      model: () => TTS_MODEL,
      apiKey: OPENAI_API_KEY as string,
    }).speak({ text: "sent", voice: "alloy" });
    const latencyMs = Math.round(performance.now() - started);

    expect(result.bytes.length).toBeGreaterThan(0);
    expect(result.mime).toMatch(/^audio\//);
    expect(result.model).toBe(TTS_MODEL);
    console.log(`[e2e] tts (${TTS_MODEL}): ${latencyMs}ms → ${result.bytes.length} bytes`);
  });
});
