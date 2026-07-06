/**
 * The correction micro-pipeline's model seam — server-side.
 *
 * A correction is a selection + a dictated/typed instruction over a transcript
 * (one segment per line); the model answers with a V4A `apply_patch` diff (see
 * `intent-pipeline/patch.ts` for the applier). Ported from the workbench's
 * `correct.ts` — the {@link SYSTEM_PROMPT} is carried over **verbatim** (the two
 * instruction modes it names are load-bearing), only the transport changes: the
 * page's `/api/chat` dev proxy becomes a direct OpenAI REST call keyed by the
 * channel process's environment.
 *
 *  - {@link mockCorrector} — no network: builds the patch locally by replacing
 *    the selection inside its line. Exercises the whole flow offline.
 *  - {@link openaiCorrector} — a small chat model emits the patch; the model may
 *    rightly touch text *outside* the selection (description mode), which is why
 *    corrections are patches, not string replaces.
 */

import type { FetchLike } from "./transcribe";

/** The transcript + selection + instruction a corrector diffs. */
export interface CorrectionInput {
  /** The transcript, one segment per line — the document the patch targets. */
  docLines: string[];
  /** The text the user selected (context for the model, not a hard boundary). */
  selected: string;
  /** The dictated or typed fix. */
  instruction: string;
}

/** A produced diff: the patch text plus which model made it, and how long it took. */
export interface CorrectionDiff {
  patch: string;
  model: string;
  latencyMs: number;
}

/** Turns a correction request into a V4A patch. */
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
      if (selected === "") {
        // Empty selected = a whole-transcript instruction (see SYSTEM_PROMPT).
        // The mock can only patch a marked span — and "replacing" the empty
        // string would insert the instruction at the head of line 1.
        throw new Error(
          "a whole-transcript instruction needs the openai corrector (mock patches a selected span)",
        );
      }
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

If SELECTED is empty (""), there is no marked span: treat the INSTRUCTION as a DESCRIPTION addressing the whole transcript — "keep only the first sentence", "drop the last part", "it's Vite everywhere, not beat". Edit exactly what the instruction asks — nothing more, nothing less — and leave every untouched line byte-identical.

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

export interface OpenAiCorrectorOptions {
  /** Resolves the chat model at call time (e.g. `gpt-4o-mini`). */
  model: () => string;
  /** The OpenAI API key. */
  apiKey: string;
  /** Injected fetch (defaults to the global). */
  fetch?: FetchLike;
  /** Override the endpoint (tests). */
  baseUrl?: string;
}

/** LLM-backed corrector against OpenAI's chat completions endpoint. */
export function openaiCorrector(options: OpenAiCorrectorOptions): Corrector {
  const doFetch = options.fetch ?? fetch;
  const baseUrl = options.baseUrl ?? "https://api.openai.com";
  return {
    name: "openai",
    async diff({ docLines, selected, instruction }) {
      const started = performance.now();
      const model = options.model();
      const res = await doFetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify({
          model,
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
      const payload = (await res.json()) as {
        error?: { message?: string };
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = payload.choices?.[0]?.message?.content;
      if (!res.ok || payload.error || !content) {
        throw new Error(payload.error?.message ?? `correction failed (${res.status})`);
      }
      if (!content.includes("*** Begin Patch")) {
        throw new Error(`model did not return a patch: ${content.slice(0, 120)}`);
      }
      return { patch: content, model, latencyMs: performance.now() - started };
    },
  };
}
