/**
 * Micro-e2e for the intent pipeline's REAL realtime (streaming) transcription
 * path (archive/streaming-turns.md §3, L1). The sibling `openai-pipeline.e2e.ts` smokes
 * the REST wire; this one smokes the realtime wire — a single ~2 s WebSocket
 * session against the live GA endpoint, asserting round-trip **shape**, never
 * output quality:
 *
 *  - the checked-in `test/fixtures/segment.wav` (16 kHz mono PCM16) is resampled
 *    in-test to 24 kHz (the realtime session's input rate — a simple linear
 *    resample, no new deps), streamed frame-by-frame through the channel's own
 *    {@link openRealtimeSession} (the production code path), committed, and the
 *    session's delta/final callbacks are collected;
 *  - asserts **at least one delta**, a **non-empty final transcript**, and that
 *    the release→final latency was recorded.
 *
 * Marker: `*.e2e.ts`, so `pnpm test` never collects it; it runs via
 * `pnpm test:e2e` (vitest.e2e.config.ts) and, in CI, the weekly openai-e2e.yml.
 * Gated on `OPENAI_API_KEY` (describe.skipIf) so forks and offline runs stay
 * green. Near-zero tokens — one short session. Latency curves and model
 * comparisons were measured by hand in the retired workbench lab, not here.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openRealtimeSession } from "@habemus-papadum/aiui-claude-channel";
import { describe, expect, it } from "vitest";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// The natively-streaming whisper the channel defaults to (openai-realtime).
const REALTIME_MODEL = "gpt-realtime-whisper";

const wavPath = fileURLToPath(new URL("./fixtures/segment.wav", import.meta.url));
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Parse a mono PCM16 WAV (tolerates a padding chunk before `data`) → 24 kHz Int16. */
function pcm24kFromWav(buf: Buffer): Int16Array {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let offset = 12; // skip "RIFF"<size>"WAVE"
  let rate = 16000;
  let dataOffset = 44;
  let dataLen = buf.length - 44;
  while (offset + 8 <= buf.length) {
    const id = String.fromCharCode(buf[offset], buf[offset + 1], buf[offset + 2], buf[offset + 3]);
    const size = view.getUint32(offset + 4, true);
    if (id === "fmt ") {
      rate = view.getUint32(offset + 12, true);
    } else if (id === "data") {
      dataOffset = offset + 8;
      dataLen = size;
    }
    offset += 8 + size + (size % 2);
  }
  const samples = new Int16Array(dataLen >> 1);
  for (let i = 0; i < samples.length; i++) {
    samples[i] = ((buf[dataOffset + i * 2] | (buf[dataOffset + i * 2 + 1] << 8)) << 16) >> 16;
  }
  if (rate === 24000) {
    return samples;
  }
  const ratio = 24000 / rate;
  const out = new Int16Array(Math.floor(samples.length * ratio));
  for (let i = 0; i < out.length; i++) {
    const src = i / ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(i0 + 1, samples.length - 1);
    out[i] = Math.round(samples[i0] + (samples[i1] - samples[i0]) * (src - i0));
  }
  return out;
}

describe.skipIf(!OPENAI_API_KEY)("openai realtime transcription · real round-trip (e2e)", () => {
  it("streams a short WAV: ≥1 delta, non-empty final, timings recorded", async () => {
    const pcm = pcm24kFromWav(readFileSync(wavPath));
    let deltas = 0;

    const result = await new Promise<{ text: string; latencyMs: number; model: string }>(
      (resolve, reject) => {
        const session = openRealtimeSession(
          { apiKey: OPENAI_API_KEY as string, model: () => REALTIME_MODEL },
          {
            onDelta: () => {
              deltas += 1;
            },
            onFinal: (_segment, r) => {
              session.close();
              resolve(r);
            },
            onError: (message) => {
              session.close();
              reject(new Error(message));
            },
          },
        );
        void (async () => {
          const frame = 2400; // 100 ms @ 24 kHz
          for (let i = 0; i < pcm.length; i += frame) {
            const slice = pcm.subarray(i, i + frame);
            session.appendAudio(
              1,
              new Uint8Array(slice.buffer, slice.byteOffset, slice.byteLength),
            );
            await sleep(20); // stream in order; shape smoke, not a latency measure
          }
          session.commit(1);
        })();
        setTimeout(() => {
          session.close();
          reject(new Error("realtime round-trip timed out (20s)"));
        }, 20_000);
      },
    );

    expect(deltas).toBeGreaterThanOrEqual(1);
    expect(result.text.trim().length).toBeGreaterThan(0);
    expect(result.latencyMs).toBeGreaterThan(0);
    console.log(
      `[e2e] realtime (${REALTIME_MODEL}): ${deltas} deltas, release→final ${Math.round(
        result.latencyMs,
      )}ms → ${result.text}`,
    );
  });
});
