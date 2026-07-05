/**
 * The lab's real (`openai`) transcriber — kept here, not in the overlay.
 *
 * The `Transcriber` seam and the `mock` implementation now live in the overlay
 * (imported by `main.ts`); the shipping modality's `openai` path runs
 * channel-side (upload a segment, merge the echoed transcript-final). The lab
 * has no channel, so it keeps this dev-proxy implementation against the same
 * interface: POST the segment to the vite dev server's `/api/transcribe`, key
 * server-side. Measured `latencyMs` is the design datum — pause-bounded REST vs
 * the not-yet-built Realtime API.
 */
import type { Transcriber } from "@habemus-papadum/aiui-dev-overlay";

/** Real transcription through the vite dev-server proxy (lab only). */
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
