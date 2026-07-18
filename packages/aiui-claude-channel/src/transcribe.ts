/**
 * Audio-container plumbing shared by the transcription path.
 *
 * The per-segment REST transcriber that used to live here (POST to OpenAI's
 * `/v1/audio/transcriptions`, one whole blob per segment) was retired
 * 2026-07-18: transcription is streaming-only — PCM `audio` chunks into a
 * per-thread realtime session (realtime.ts / elevenlabs-realtime.ts). Old
 * hellos asking for the REST engine coerce onto the streaming one at resolve
 * (intent-v1.ts). What survives is the container→extension mapping the trace
 * store still names saved segment blobs with, and the shared FetchLike.
 */

/** A cross-realm `fetch` — Node's global, or a test double with the same shape. */
export type FetchLike = typeof fetch;

/**
 * OpenAI sniffs an uploaded audio file by its **filename extension**, not the
 * content-type header (an archive/workbench/field-notes.md finding that cost a round of confusing
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
