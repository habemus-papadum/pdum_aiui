/**
 * Micro-e2e for the flagship conversational voice path (model-tiers.md T3). The
 * sibling `openai-realtime.e2e.ts` smokes the streaming STT wire; this one smokes
 * the talk-back wire — a single short `gpt-realtime-2` session against the live GA
 * endpoint, asserting round-trip **shape**, never quality:
 *
 *  - the checked-in `test/fixtures/segment.wav` is resampled to 24 kHz, streamed
 *    frame-by-frame through the channel's own {@link openRealtimeVoiceSession}
 *    (the production code path), then committed (which fires `response.create`);
 *  - asserts the model **answered aloud** (≥1 buffered audio clip), that its
 *    **spoken-reply transcript** is non-empty, that the **user's input transcript**
 *    (the IR-feeding one) is non-empty, and that the session **closes cleanly**.
 *
 * COST: one short spoken reply — cents, not dollars — because it commits ONE ~2 s
 * segment and the session's own per-thread response cap bounds the replies. The
 * fixture is capped short on purpose. Marker `*.e2e.ts` (so `pnpm test` skips it);
 * runs via `pnpm test:e2e` and the weekly openai-e2e.yml, gated on OPENAI_API_KEY.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  openRealtimeVoiceSession,
  type VoiceAudioClip,
} from "@habemus-papadum/aiui-claude-channel";
import { describe, expect, it } from "vitest";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const VOICE_MODEL = "gpt-realtime-2";

const wavPath = fileURLToPath(new URL("./fixtures/segment.wav", import.meta.url));
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Parse a mono PCM16 WAV (tolerates a padding chunk before `data`) → 24 kHz Int16. */
function pcm24kFromWav(buf: Buffer): Int16Array {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let offset = 12;
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

describe.skipIf(!OPENAI_API_KEY)("openai flagship voice · real round-trip (e2e)", () => {
  it("streams a short WAV, gets a spoken reply: audio + reply transcript + user transcript", async () => {
    const pcm = pcm24kFromWav(readFileSync(wavPath));
    let userTranscript = "";
    let replyTranscript = "";
    const clips: VoiceAudioClip[] = [];

    const result = await new Promise<{ ok: boolean }>((resolve, reject) => {
      const started = Date.now();
      const session = openRealtimeVoiceSession(
        { apiKey: OPENAI_API_KEY as string, model: () => VOICE_MODEL, voice: () => "cedar" },
        {
          onUserDelta: () => {},
          onUserFinal: (_segment, r) => {
            userTranscript = r.text;
          },
          onAudio: (clip) => {
            clips.push(clip);
            console.log(
              `[e2e] flagship (${VOICE_MODEL}): reply-audio ${Date.now() - started}ms, ` +
                `${clip.bytes.length} bytes (${clip.mime})`,
            );
            // Give the reply transcript a beat to land, then finish.
            setTimeout(() => {
              session.close();
              resolve({ ok: true });
            }, 300);
          },
          onReplyTranscript: (text) => {
            replyTranscript = text;
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
          session.appendAudio(1, new Uint8Array(slice.buffer, slice.byteOffset, slice.byteLength));
          await sleep(20);
        }
        session.commit(1); // release → response.create
      })();
      setTimeout(() => {
        session.close();
        reject(new Error("flagship round-trip timed out (30s)"));
      }, 30_000);
    });

    expect(result.ok).toBe(true);
    expect(clips.length).toBeGreaterThanOrEqual(1);
    expect(clips[0].bytes.length).toBeGreaterThan(0);
    expect(replyTranscript.trim().length).toBeGreaterThan(0);
    expect(userTranscript.trim().length).toBeGreaterThan(0);
    console.log(
      `[e2e] flagship (${VOICE_MODEL}): user="${userTranscript}" reply="${replyTranscript}"`,
    );
  });
});
