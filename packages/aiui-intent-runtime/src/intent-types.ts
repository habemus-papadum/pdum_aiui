/**
 * The intent-thread contract, as a LEAF module: `IntentThread` (one open
 * thread's verbs over the channel socket) and `OpenThreadOptions`. Kept a
 * leaf on purpose: wire-level consumers import the types without pulling any
 * host's whole module graph into their TypeScript programs (a type-only
 * import still typechecks the imported file).
 */
import type {
  Ack,
  AttachmentChunk,
  AudioChunk,
  JsonChunk,
  ServerMessage,
  VideoChunk,
} from "./protocol";

export interface IntentThread {
  /** Send a non-final JSON payload (streaming modalities). */
  send(payload: unknown): Promise<Ack>;
  /** Send the final payload (`fin`) and release the connection. */
  finish(payload?: unknown): Promise<Ack>;
  /**
   * Send a tagged JSON chunk (an `events` batch or the end-of-turn `context`)
   * — the `intent-v1` streaming form. `fin` marks the thread's final frame.
   */
  sendChunk(chunk: JsonChunk, payload: unknown, fin?: boolean): Promise<Ack>;
  /** Send a raw-binary attachment chunk (a shot PNG or a whole audio segment). */
  sendAttachment(chunk: AttachmentChunk, bytes: Uint8Array, fin?: boolean): Promise<Ack>;
  /** Send one streamed PCM frame of a talk segment (the realtime path). */
  sendAudio(chunk: AudioChunk, bytes: Uint8Array, fin?: boolean): Promise<Ack>;
  /** Send one sampled screen-share video frame (the realtime submode's ~1 fps sampler). */
  sendVideo(chunk: VideoChunk, bytes: Uint8Array, fin?: boolean): Promise<Ack>;
  /** Register a handler for this thread's server pushes (lowered echoes). */
  onServerMessage(handler: (msg: ServerMessage) => void): void;
  /** Close the underlying socket without sending `fin` (a cancel). */
  close(): void;
}

/** Extra per-thread options a modality passes to {@link IntentToolContext.openThread}. */
export interface OpenThreadOptions {
  /**
   * A JSON-serializable client config to ride the hello as `meta.intent` (the
   * `intent-v1` modality's effective `IntentPipelineConfig`), so a lowering
   * trace records the whole configuration.
   */
  intent?: Record<string, unknown>;
}
