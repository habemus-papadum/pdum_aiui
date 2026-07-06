/**
 * The correction micro-pipeline seam and its mock.
 *
 * A `Corrector` takes the whole transcript (one segment per line), the selected
 * span, and the dictated/typed instruction, and returns a **V4A patch** (see
 * intent-pipeline/patch.ts for the format and apply logic). The overlay ships
 * the **mock** — builds the patch locally by replacing the selection inside its
 * line, offline and instant. The real `openai` correction runs **channel-side**
 * (the model may rightly touch text outside the selection — "make it plural
 * everywhere" — which is the whole reason corrections are patches, not string
 * replaces): the modality streams a patchless correction to the server and
 * awaits the echoed patch (see modality.ts). The workbench lab keeps its own
 * dev-proxy `openai` corrector against this interface.
 *
 * `SYSTEM_PROMPT` is the prompt that names the two instruction modes; it lives
 * here so the lab's `openai` corrector uses exactly the text the channel ports.
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
