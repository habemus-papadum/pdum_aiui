/**
 * Payload codecs: the format-specific half of the wire protocol.
 *
 * The {@link ./frame} envelope is the same for every message; the *payload*
 * bytes are produced and consumed by a codec chosen per stream format. A codec
 * is the pair of pure functions that turn a user payload into bytes and back —
 * `encode` runs on the client, `decode` on the server (see {@link ./channel}).
 *
 * The two here are the shared, format-independent building blocks:
 *  - {@link jsonCodec} marshals a payload to/from JSON (for text-shaped
 *    formats like `text-concat`);
 *  - {@link rawCodec} is the identity codec (the payload *is* the bytes) — the
 *    efficient path for already-encoded audio, video, and screenshots.
 *
 * A format can also define its own codec (e.g. an Opus or JPEG framing) and
 * reuse these where it fits.
 */

/** Encodes a user payload of type `T` to bytes and decodes it back. */
export interface PayloadCodec<T = unknown> {
  /** Stable identifier, handy for logging/diagnostics (e.g. `"json"`). */
  readonly id: string;
  /** Serialize a payload to the bytes carried after the frame header. */
  encode(payload: T): Uint8Array;
  /** Parse payload bytes back into a value. An empty payload is valid. */
  decode(bytes: Uint8Array): T;
}

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * Marshals a payload to/from UTF-8 JSON. An empty payload decodes to
 * `undefined` (so a header-only `data` frame — e.g. a bare end-of-stream
 * marker — carries no bytes); `undefined` encodes to the JSON literal `null`.
 */
export const jsonCodec: PayloadCodec<unknown> = {
  id: "json",
  encode: (payload) => utf8Encoder.encode(JSON.stringify(payload ?? null)),
  decode: (bytes) => (bytes.length === 0 ? undefined : JSON.parse(utf8Decoder.decode(bytes))),
};

/**
 * The identity codec: the payload already *is* its bytes. This is the path
 * that keeps audio/video/screenshot frames raw end to end — no base64, no
 * re-encoding.
 */
export const rawCodec: PayloadCodec<Uint8Array> = {
  id: "raw",
  encode: (payload) => payload,
  decode: (bytes) => bytes,
};
