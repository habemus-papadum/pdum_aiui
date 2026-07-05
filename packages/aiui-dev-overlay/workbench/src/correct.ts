/**
 * The correction micro-pipeline: selection + instruction → LLM → V4A patch.
 *
 * Mirrors the Transcriber seam: a `Corrector` takes the whole transcript (one
 * segment per line), the selected span, and the dictated/typed instruction,
 * and returns a patch (see patch.ts for the format and the apply logic). Two
 * implementations:
 *
 *  - **mock** — no network: builds the patch locally by replacing the
 *    selection inside its line. Exercises the entire flow (event shapes,
 *    diff flash, apply) offline.
 *  - **openai** — a small chat model emits the patch through the dev server's
 *    /api/chat proxy. This is the interesting case: the model may rightly
 *    touch text *outside* the selection ("make it plural everywhere"), which
 *    is the whole reason corrections are patches and not string replaces.
 */

export interface CorrectionInput {
  /** The transcript, one segment per line — the document the patch targets. */
  docLines: string[];
  /** The text the user selected (context for the model, not a hard boundary). */
  selected: string;
  /** The dictated or typed fix. */
  instruction: string;
}

export interface CorrectionDiff {
  patch: string;
  model: string;
  latencyMs: number;
}

export interface Corrector {
  readonly name: string;
  diff(input: CorrectionInput): Promise<CorrectionDiff>;
}

/** Local, deterministic: replace the selection inside the line containing it. */
export function mockCorrector(): Corrector {
  return {
    name: "mock",
    async diff({ docLines, selected, instruction }) {
      const started = performance.now();
      const line = docLines.find((l) => l.includes(selected));
      if (!line) {
        throw new Error(`selection not found in transcript: ${JSON.stringify(selected)}`);
      }
      const patch = [
        "*** Begin Patch",
        "*** Update File: transcript",
        "@@",
        `-${line}`,
        `+${line.replace(selected, instruction)}`,
        "*** End Patch",
      ].join("\n");
      return { patch, model: "mock", latencyMs: performance.now() - started };
    },
  };
}

export const SYSTEM_PROMPT = `You fix dictation transcripts. You receive a TRANSCRIPT (one segment per line), the SELECTED span the user marked, and an INSTRUCTION (usually itself dictated).

The instruction comes in two distinct modes — recognize which one you're in:

1. REPLACEMENT: the instruction is verbatim text that should replace the selected span. It reads like content, not like a sentence about content. Example: selected "curb", instruction "curve" → swap the span, touch nothing else.

2. DESCRIPTION: the instruction *describes* the change — it talks about the text ("no, it's not beat, it's Vite, the frontend framework"). Infer the intended edit. The selection is then just the example occurrence / context: if the same mis-transcription appears elsewhere in the transcript, fix EVERY occurrence, not only the selected one. Descriptions often carry disambiguating context (what a word means, how it's spelled) — use it, don't include it in the text.

Cues: instructions starting with "no", "not", "I meant", "it should say", or containing explanations ("the framework", "with a K") are descriptions. A bare word or phrase is a replacement.

Reply with ONLY a patch in this exact format — no commentary, no code fences:

*** Begin Patch
*** Update File: transcript
@@
-<exact existing line>
+<corrected line>
*** End Patch

Rules:
- Lines you remove (-) must be copied EXACTLY from the transcript.
- Make the smallest edit that satisfies the instruction — but in DESCRIPTION mode, "smallest" still means all affected occurrences across the whole transcript.
- Multiple hunks are allowed, each introduced by @@.`;

/** LLM-backed corrector via the dev server's /api/chat proxy. */
export function openaiCorrector(model: () => string): Corrector {
  return {
    name: "openai",
    async diff({ docLines, selected, instruction }) {
      const started = performance.now();
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: model(),
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
      const payload = (await res.json()) as { content?: string; error?: string };
      if (!res.ok || payload.error || !payload.content) {
        throw new Error(payload.error ?? `correction failed (${res.status})`);
      }
      if (!payload.content.includes("*** Begin Patch")) {
        throw new Error(`model did not return a patch: ${payload.content.slice(0, 120)}`);
      }
      return { patch: payload.content, model: model(), latencyMs: performance.now() - started };
    },
  };
}
