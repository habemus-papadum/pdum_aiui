/**
 * The transcription seam — server-side, where the OpenAI key belongs.
 *
 * The workbench proved this seam page-side against a dev-server `/api/transcribe`
 * proxy (see `workbench/src/transcribe.ts`); graduating the lowering into the
 * channel moves the real call here, keyed by the channel process's environment.
 * A segment's raw bytes + container MIME go in, a timed transcript comes out.
 *
 *  - {@link mockTranscriber} — no network, no key: returns a canned/derived
 *    string. The default for tests and the offline/degraded path.
 *  - {@link openaiTranscriber} — POSTs the segment to OpenAI's REST STT
 *    (`/v1/audio/transcriptions`). REST is segment-at-a-time (no partials), so
 *    the measured `latencyMs` is the design datum the audio-stack notes track.
 *
 * `fetch` is injected so tests exercise the real request shape without a
 * network (the reason the workbench's proxy existed is the same reason the key
 * lives here and not on the page).
 */

/** A cross-realm `fetch` — Node's global, or a test double with the same shape. */
export type FetchLike = typeof fetch;

/** One transcription result: the text plus how long and which model produced it. */
export interface TranscriptResult {
  text: string;
  latencyMs: number;
  model: string;
}

/** A pause-bounded audio segment to transcribe: its bytes and container MIME. */
export interface TranscribeInput {
  bytes: Uint8Array;
  /** e.g. `audio/webm;codecs=opus`, `audio/wav` — drives the upload filename. */
  mime: string;
}

/** Turns an audio segment into text. */
export interface Transcriber {
  readonly name: string;
  transcribe(input: TranscribeInput): Promise<TranscriptResult>;
}

/**
 * OpenAI sniffs an uploaded audio file by its **filename extension**, not the
 * content-type header (a workbench field-note that cost a round of confusing
 * 400s): name the multipart file to match the container or transcription
 * rejects it. Map the leading MIME type to the extension OpenAI expects.
 */
export function audioExtensionForMime(mime: string): string {
  const base = mime.split(";")[0].trim().toLowerCase();
  switch (base) {
    case "audio/webm":
      return "webm";
    case "audio/wav":
    case "audio/x-wav":
    case "audio/wave":
      return "wav";
    case "audio/mp4":
    case "audio/m4a":
    case "audio/x-m4a":
      return "m4a";
    case "audio/mpeg":
    case "audio/mp3":
      return "mp3";
    case "audio/ogg":
      return "ogg";
    case "audio/flac":
      return "flac";
    default:
      // A sensible default: opus-in-webm is what MediaRecorder emits by default.
      return "webm";
  }
}

/** Local, deterministic transcriber: no key, no network. */
export function mockTranscriber(
  reply: (input: TranscribeInput) => string = () => "mock transcript",
): Transcriber {
  return {
    name: "mock",
    async transcribe(input) {
      const started = performance.now();
      return { text: reply(input), latencyMs: performance.now() - started, model: "mock" };
    },
  };
}

export interface OpenAiTranscriberOptions {
  /** Resolves the model name at call time (e.g. `gpt-4o-mini-transcribe`). */
  model: () => string;
  /** The OpenAI API key. */
  apiKey: string;
  /** Injected fetch (defaults to the global). */
  fetch?: FetchLike;
  /** Override the endpoint (tests). */
  baseUrl?: string;
}

/** Real transcription against OpenAI's REST STT endpoint. */
export function openaiTranscriber(options: OpenAiTranscriberOptions): Transcriber {
  const doFetch = options.fetch ?? fetch;
  const baseUrl = options.baseUrl ?? "https://api.openai.com";
  return {
    name: "openai",
    async transcribe({ bytes, mime }) {
      const started = performance.now();
      const model = options.model();
      const form = new FormData();
      // Copy the payload into a fresh, exactly-sized array. `bytes` is
      // typically a Buffer *view* into the received ws frame (the payload
      // sliced out of its envelope) — and Buffer.prototype.slice(), unlike
      // Uint8Array's, returns another view, NOT a copy. The previous
      // `bytes.slice().buffer` therefore handed the Blob the ENTIRE
      // underlying frame allocation — envelope bytes, Buffer-pool neighbors
      // and all — which OpenAI rejected as "corrupted or unsupported" audio
      // while the very same segment saved to the trace store played fine.
      // A Blob part built from a typed array respects the view's bounds.
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      // Filename extension must match the container (see audioExtensionForMime)
      // or OpenAI 400s on the sniff.
      const ext = audioExtensionForMime(mime);
      const blob = new Blob([copy], { type: mime.split(";")[0] });
      form.append("file", blob, `segment.${ext}`);
      form.append("model", model);
      const res = await doFetch(`${baseUrl}/v1/audio/transcriptions`, {
        method: "POST",
        headers: { authorization: `Bearer ${options.apiKey}` },
        body: form,
      });
      const payload = (await res.json()) as { text?: string; error?: { message?: string } };
      if (!res.ok || payload.error) {
        throw new Error(payload.error?.message ?? `transcription failed (${res.status})`);
      }
      return { text: payload.text ?? "", latencyMs: performance.now() - started, model };
    },
  };
}
