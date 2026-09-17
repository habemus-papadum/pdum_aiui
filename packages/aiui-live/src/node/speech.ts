/**
 * speech.ts — a scripted user for headless sessions. `scriptedMic` is an
 * {@link AudioSource} that plays queued PCM in real time and silence
 * otherwise; `synthesize` turns text into PCM through the vendor's TTS (the
 * probe's trick — a session cannot tell synthesized speech from a person);
 * `wavFile` writes what the assistant said so a human can listen back.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AudioSource } from "./ws-transport.ts";

export const PCM_RATE = 24000;

export interface ScriptedMicOptions {
  rate?: number;
  chunkMs?: number;
}

export interface ScriptedMic extends AudioSource {
  /** Queue an utterance; resolves when its last chunk has been SENT. */
  say(pcm: Uint8Array): Promise<{ startMs: number; endMs: number }>;
  /** ms of audio sent so far — the session timeline, approximately. */
  sentMs(): number;
}

export function scriptedMic(options: ScriptedMicOptions = {}): ScriptedMic {
  const rate = options.rate ?? PCM_RATE;
  const chunkMs = options.chunkMs ?? 100;
  const chunkBytes = (rate * 2 * chunkMs) / 1000;
  const silence = new Uint8Array(chunkBytes);
  const queue: Uint8Array[] = [];
  let timer: ReturnType<typeof setInterval> | undefined;
  let sent = 0;
  let enabled = true;
  return {
    start(push) {
      if (timer !== undefined) {
        return;
      }
      timer = setInterval(() => {
        const chunk = enabled ? (queue.shift() ?? silence) : silence;
        push(chunk);
        sent += chunkMs;
      }, chunkMs);
    },
    stop() {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    },
    setEnabled(on) {
      enabled = on;
    },
    async say(pcm) {
      const startMs = sent + queue.length * chunkMs;
      for (let i = 0; i < pcm.length; i += chunkBytes) {
        const piece = pcm.subarray(i, i + chunkBytes);
        if (piece.length < chunkBytes) {
          const padded = new Uint8Array(chunkBytes);
          padded.set(piece);
          queue.push(padded);
        } else {
          queue.push(piece);
        }
      }
      const durMs = Math.ceil(pcm.length / chunkBytes) * chunkMs;
      while (queue.length > 0) {
        await new Promise((resolve) => setTimeout(resolve, chunkMs));
      }
      return { startMs, endMs: startMs + durMs };
    },
    sentMs: () => sent,
  };
}

export interface SynthesizeOptions {
  key: string;
  /** Default `alloy` — deliberately not a live voice, so the two are distinguishable. */
  voice?: string;
  model?: string;
  /** Cache directory for the PCM (keyed by text+voice). */
  cacheDir?: string;
  fetchImpl?: typeof fetch;
}

/** Text → 24 kHz mono PCM16 via `POST /v1/audio/speech`. */
export async function synthesize(text: string, options: SynthesizeOptions): Promise<Buffer> {
  const voice = options.voice ?? "alloy";
  const model = options.model ?? "gpt-4o-mini-tts";
  const file =
    options.cacheDir === undefined
      ? undefined
      : join(
          options.cacheDir,
          `${createHash("sha1").update(`${model}|${voice}|${text}`).digest("hex").slice(0, 16)}.pcm`,
        );
  if (file !== undefined && existsSync(file)) {
    return readFileSync(file);
  }
  const doFetch = options.fetchImpl ?? fetch;
  const response = await doFetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { Authorization: `Bearer ${options.key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, voice, input: text, response_format: "pcm" }),
  });
  if (!response.ok) {
    throw new Error(`tts ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
  const pcm = Buffer.from(await response.arrayBuffer());
  if (file !== undefined) {
    mkdirSync(options.cacheDir as string, { recursive: true });
    writeFileSync(file, pcm);
  }
  return pcm;
}

/** Wrap PCM16 mono in a WAV header. */
export function pcmToWav(pcm: Buffer, rate = PCM_RATE): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Collect output audio and write it as a WAV on demand. */
export function wavSink(rate = PCM_RATE): {
  push(pcm: Buffer): void;
  write(path: string): number;
  seconds(): number;
} {
  const chunks: Buffer[] = [];
  let bytes = 0;
  return {
    push(pcm) {
      chunks.push(pcm);
      bytes += pcm.length;
    },
    write(path) {
      writeFileSync(path, pcmToWav(Buffer.concat(chunks), rate));
      return bytes;
    },
    seconds: () => bytes / (rate * 2),
  };
}
