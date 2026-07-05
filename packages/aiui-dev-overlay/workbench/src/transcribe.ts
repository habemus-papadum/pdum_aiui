/**
 * Transcribers — the model-methodology axis of the workbench.
 *
 * The interface is what the eventual modality will program against: a segment
 * blob in, streamed deltas + a timed final out. Two implementations today:
 *
 *  - **mock** — no network, no keys. Streams canned phrases at a settable
 *    word cadence and injects typos at a settable rate, precisely so the
 *    correction meta-mode has something real to fix. This is the default and
 *    the one to design interaction against.
 *  - **openai** — POSTs the segment to the dev server's /api/transcribe proxy
 *    (OPENAI_API_KEY server-side; models like whisper-1 / gpt-4o-transcribe /
 *    gpt-4o-mini-transcribe). REST is segment-at-a-time — no partials — so
 *    the measured `latencyMs` IS the design datum: it tells you whether
 *    pause-bounded segments feel live enough, or whether the Realtime API
 *    (WebRTC/WS, ephemeral tokens — not built yet) is required.
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

/** Deterministic-ish mock: cadence and typo rate come from settings. */
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

/** Real transcription through the vite dev-server proxy. */
export function openaiTranscriber(model: () => string): Transcriber {
  return {
    name: "openai",
    async transcribe(segment, onDelta) {
      const started = performance.now();
      const res = await fetch(`/api/transcribe?model=${encodeURIComponent(model())}`, {
        method: "POST",
        headers: { "content-type": segment.type || "audio/webm" },
        body: segment,
      });
      const payload = (await res.json()) as {
        error?: string;
        upstreamMs?: number;
        result?: { text?: string; error?: { message?: string } };
      };
      if (!res.ok || payload.error || payload.result?.error) {
        throw new Error(
          payload.error ?? payload.result?.error?.message ?? `transcription failed (${res.status})`,
        );
      }
      const text = payload.result?.text ?? "";
      onDelta(text); // REST has no partials — one delta, then final
      return { text, latencyMs: performance.now() - started, model: model() };
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
