/**
 * The intent tool's error-toast state — a small, pure model the host renders.
 *
 * The intent tool used to fail quietly: server-side faults (a stale
 * OPENAI_API_KEY failing every transcription) surfaced only as a status line
 * in the panel footer — invisible whenever the panel is closed, which is the
 * normal state while driving the multimodal modality — and transport faults
 * (channel down, socket dropped mid-turn) often surfaced nowhere at all. The
 * fix is one generic error surface: server-side failures ride a `kind:"error"`
 * push (see `ErrorMessage` in protocol.ts), client-detected failures call the
 * same `IntentToolContext.reportError`, and both render as dismissible toasts
 * next to the tool's fab.
 *
 * This module is the toast *state*, kept pure (list in → list out) so the
 * dedupe/cap/dismiss rules are unit-testable without a DOM:
 *
 *  - **Dedupe.** A repeat of the same `source` + `message` never stacks a new
 *    toast — the existing one bumps its count and moves to the newest slot.
 *    This is what keeps a streaming failure (one bad ack per PCM frame) at one
 *    toast with a climbing ×N instead of a wall of identical boxes.
 *  - **Cap.** The list never exceeds {@link ERROR_TOAST_CAP} entries; the
 *    oldest falls off. Errors are hints, not a log — the lowering trace and the
 *    DevTools panel are the archival surfaces.
 *  - **Dismiss.** Removal by id; there is no auto-expiry. A toast the user has
 *    not acknowledged describes a condition that is probably still true (the
 *    channel is still down, the key is still stale), so it stays until
 *    dismissed or displaced.
 */

/** What a failure site reports: a short human message, plus optional context. */
export interface OverlayErrorInput {
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
   * saw it (an API error object, a close code + reason). Rendered behind the
   * toast's collapsed "details" expander via {@link formatErrorData}, so the
   * human can read what the API actually said, not just our one-line gloss.
   */
  data?: unknown;
}

/** One live toast: the input plus identity, repeat count, and freshness. */
export interface OverlayError extends OverlayErrorInput {
  /** Stable handle for dismissal (unique within the current list). */
  id: number;
  /** How many times this source+message has been reported while displayed. */
  count: number;
  /** When it was last reported (epoch ms). */
  at: number;
}

/** How many toasts show at once — oldest entries fall off beyond this. */
export const ERROR_TOAST_CAP = 3;

export interface AddErrorOptions {
  /** Override the cap (tests). Defaults to {@link ERROR_TOAST_CAP}. */
  cap?: number;
  /** Injected clock (tests). Defaults to `Date.now()`. */
  now?: number;
}

/**
 * Report an error into the toast list, returning the new list (newest last —
 * the renderer anchors the column at the bottom, so last = nearest the fab).
 * A repeat of an existing `source`+`message` bumps that entry's count and
 * refreshes its `detail`/timestamp instead of adding a twin; a genuinely new
 * error appends, evicting the oldest entry past the cap.
 */
export function addError(
  list: readonly OverlayError[],
  input: OverlayErrorInput,
  options: AddErrorOptions = {},
): OverlayError[] {
  const cap = options.cap ?? ERROR_TOAST_CAP;
  const now = options.now ?? Date.now();
  const existingIndex = list.findIndex(
    (entry) => entry.source === input.source && entry.message === input.message,
  );
  if (existingIndex >= 0) {
    const existing = list[existingIndex];
    const bumped: OverlayError = {
      ...existing,
      ...(input.detail !== undefined ? { detail: input.detail } : {}),
      ...(input.data !== undefined ? { data: input.data } : {}),
      count: existing.count + 1,
      at: now,
    };
    // Move the refreshed entry to the newest slot so it reads as "just happened".
    return [...list.filter((_, i) => i !== existingIndex), bumped];
  }
  // Ids only need to be unique within the live list; max+1 over what is present
  // can never collide with a shown entry, and a dismissed one has no handle left.
  const id = list.reduce((max, entry) => Math.max(max, entry.id), 0) + 1;
  const entry: OverlayError = {
    id,
    count: 1,
    at: now,
    message: input.message,
    ...(input.source !== undefined ? { source: input.source } : {}),
    ...(input.detail !== undefined ? { detail: input.detail } : {}),
    ...(input.data !== undefined ? { data: input.data } : {}),
  };
  const next = [...list, entry];
  return next.length > cap ? next.slice(next.length - cap) : next;
}

/**
 * Render a toast's structured `data` for the details expander: objects
 * pretty-print as 2-space JSON; a string that *parses* as JSON pretty-prints
 * the same way (upstream bodies often arrive as raw text); any other string
 * shows verbatim. Pure — the widget just drops the result in a `<pre>`.
 */
export function formatErrorData(data: unknown): string {
  if (typeof data === "string") {
    try {
      return JSON.stringify(JSON.parse(data), null, 2);
    } catch {
      return data;
    }
  }
  try {
    return JSON.stringify(data, null, 2) ?? String(data);
  } catch {
    // circular or otherwise unserializable — the expander still shows something
    return String(data);
  }
}

/** Dismiss a toast by id, returning the new list (unknown ids are a no-op). */
export function dismissError(list: readonly OverlayError[], id: number): OverlayError[] {
  return list.filter((entry) => entry.id !== id);
}
