/**
 * The runtime's error-reporting contract. Server-side failures ride a
 * `kind:"error"` push (see `ErrorMessage` in protocol.ts); client-detected
 * failures call the host's deps-injected `reportError` (`WireDeps`, the talk
 * lanes' deps) with an {@link IntentErrorInput}. How the host surfaces the
 * report (toast, status line, log) is its own business.
 */

/** What a failure site reports: a short human message, plus optional context. */
export interface IntentErrorInput {
  /** One informative sentence — what failed and, ideally, what to do about it. */
  message: string;
  /**
   * Where it failed — a coarse category (`"connection"`, `"transcription"`,
   * `"correction"`, …) shown as the toast's badge and used (with `message`) as
   * the dedupe key. Free-form so new failure sites need no enum change.
   */
  source?: string;
  /** Optional second line — remediation, an upstream error body, a close reason. */
  detail?: string;
  /**
   * Optional structured payload — the raw upstream error exactly as the server
   * saw it (an API error object, a close code + reason).
   */
  data?: unknown;
}
