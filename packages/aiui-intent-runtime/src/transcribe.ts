/**
 * The transcriber seam and its mock.
 *
 * The interface is what the talk lanes program against: a segment blob in,
 * streamed deltas + a timed final out. This runtime ships one implementation —
 * the **mock** (canned phrases, injectable typos, settable cadence), used
 * offline and to design interaction against. The real `openai` transcription
 * does NOT live behind this seam: it runs **channel-side** (the key belongs
 * with the channel, not the page) — the talk lanes upload the recorded
 * segment as an `intent-v1` attachment and merge the transcript-final the
 * server echoes back. (The retired workbench lab ran a dev-proxy `openai`
 * transcriber against this same interface — the seam supports per-host
 * implementations.)
 */

export interface TranscriptResult {
  text: string;
  latencyMs: number;
  model: string;
}

export interface Transcriber {
  readonly name: string;
  transcribe(segment: Blob, onDelta: (text: string) => void): Promise<TranscriptResult>;
}

const CANNED = [
  "make the baseline curve a bit thicker and color it amber",
  "the legend overlaps the plot on narrow screens can you move it below",
  "add a subtle grid to the spectrum and label the peak near five fifty",
  "this toolbar button should open a settings drawer instead of an alert",
  "the sample table needs a column for acquisition time",
];

const TYPOS: Array<[RegExp, string]> = [
  [/\bbaseline\b/, "base line"],
  [/\bcurve\b/, "curb"],
  [/\blegend\b/, "ledge end"],
  [/\bpeak\b/, "peek"],
  [/\btoolbar\b/, "tool bar"],
  [/\bamber\b/, "ember"],
  [/\bcolumn\b/, "colon"],
];

/** Deterministic-ish mock: cadence and typo rate come from config. */
export function mockTranscriber(opts: {
  wordMs: () => number;
  typoRate: () => number;
}): Transcriber {
  let cursor = 0;
  return {
    name: "mock",
    async transcribe(_segment, onDelta) {
      const started = performance.now();
      let text = CANNED[cursor++ % CANNED.length];
      for (const [pattern, mangled] of TYPOS) {
        if (pattern.test(text) && Math.random() < opts.typoRate()) {
          text = text.replace(pattern, mangled);
        }
      }
      const words = text.split(" ");
      let emitted = "";
      for (const word of words) {
        await sleep(opts.wordMs());
        emitted = emitted ? `${emitted} ${word}` : word;
        onDelta(emitted);
      }
      return { text: emitted, latencyMs: performance.now() - started, model: "mock" };
    },
  };
}

function sleep(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));
}
