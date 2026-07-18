/**
 * Cost accounting for the model calls the lowering pipeline makes.
 *
 * Every paid hop — the summarizer, TTS
 * acks, realtime STT/linter sessions — reports what it spent, the trace records
 * it per call, and the manifest keeps a running roll-up (see
 * {@link TraceHandle.addCost}). Claude Code session costs are deliberately out
 * of scope (that accounting belongs to the harness, reachable later via
 * hooks); this is about the *pipeline's own* spend.
 *
 * Prices come from [@pydantic/genai-prices](https://github.com/pydantic/genai-prices)
 * — a maintained multi-provider catalog whose `Usage` shape is natively
 * multimodal (audio input/output tokens, cache reads) and whose bundled data
 * ships with the package. Two properties of the wrapper here matter more than
 * the arithmetic:
 *
 *  - **It never throws.** `calcPrice` validates aggressively (audio tokens
 *    must not exceed totals, and some providers report them inconsistently);
 *    a pricing hiccup must never take down a lowering turn, so usage is
 *    normalized first and any residual failure degrades to "usage recorded,
 *    no price".
 *  - **Unknown models still account.** The catalog lags brand-new models
 *    (e.g. `gpt-realtime-whisper` today); those calls report their usage with
 *    `usd` absent rather than vanishing — the trace shows *what* was consumed
 *    even when it can't say what it cost.
 *
 * The `Usage` field semantics (per genai-prices): `input_tokens` /
 * `output_tokens` are **totals**; `input_audio_tokens` / `output_audio_tokens`
 * are the audio *subsets* of those totals — which is also how OpenAI reports
 * `*_token_details`, so the mappers below are mostly renames.
 */
import { calcPrice, type Usage } from "@pydantic/genai-prices";

export type { Usage } from "@pydantic/genai-prices";

/** What one model call cost — or, when the catalog has no price, what it used. */
export interface CallCost {
  /** Total USD; absent when the model isn't in the price catalog. */
  usd?: number;
  /** The pricing providerId the lookup used (`openai`, `google`, …). */
  provider: string;
  model: string;
  /** The normalized usage the price was computed from. */
  usage: Usage;
  /**
   * True when the usage itself is a guess (e.g. TTS: `/v1/audio/speech`
   * returns no usage at all, so input tokens are estimated from text length
   * and the audio output isn't priced) — an `usd` here is a floor, not a fact.
   */
  estimated?: true;
}

/**
 * Normalize a usage so `calcPrice` can't reject it: audio subsets may not
 * exceed their totals (a rule some transports violate by omitting the total),
 * so totals are raised to cover the subset rather than dropping the call.
 */
export function normalizeUsage(usage: Usage): Usage {
  const out: Usage = { ...usage };
  if (out.input_audio_tokens !== undefined) {
    out.input_tokens = Math.max(out.input_tokens ?? 0, out.input_audio_tokens);
  }
  if (out.output_audio_tokens !== undefined) {
    out.output_tokens = Math.max(out.output_tokens ?? 0, out.output_audio_tokens);
  }
  return out;
}

/**
 * Price one call. Always returns an accounting record (usage is worth keeping
 * even unpriced); never throws.
 */
export function priceCall(
  provider: "openai" | "google",
  model: string,
  usage: Usage,
  opts: { estimated?: boolean } = {},
): CallCost {
  const normalized = normalizeUsage(usage);
  let usd: number | undefined;
  try {
    const result = calcPrice(normalized, model, { providerId: provider });
    usd = result?.total_price;
  } catch {
    usd = undefined; // pricing must never break the pipeline
  }
  return {
    ...(usd !== undefined && Number.isFinite(usd) ? { usd } : {}),
    provider,
    model,
    usage: normalized,
    ...(opts.estimated ? { estimated: true as const } : {}),
  };
}

// ── OpenAI usage-shape mappers ────────────────────────────────────────────────
// Each transport reports usage in its own dialect; these fold them into the
// genai-prices shape. All are tolerant: garbage in → undefined out, and the
// call simply goes unaccounted rather than unprocessed.

/** `/v1/chat/completions` usage → Usage (the summarizer). */
export function usageFromChatCompletions(raw: unknown): Usage | undefined {
  const u = asRecord(raw);
  if (!u || typeof u.prompt_tokens !== "number") {
    return undefined;
  }
  const promptDetails = asRecord(u.prompt_tokens_details);
  const completionDetails = asRecord(u.completion_tokens_details);
  return {
    input_tokens: u.prompt_tokens,
    ...(typeof u.completion_tokens === "number" ? { output_tokens: u.completion_tokens } : {}),
    ...(typeof promptDetails?.audio_tokens === "number"
      ? { input_audio_tokens: promptDetails.audio_tokens }
      : {}),
    ...(typeof promptDetails?.cached_tokens === "number"
      ? { cache_read_tokens: promptDetails.cached_tokens }
      : {}),
    ...(typeof completionDetails?.audio_tokens === "number"
      ? { output_audio_tokens: completionDetails.audio_tokens }
      : {}),
  };
}

/**
 * Transcription usage → Usage: `{input_tokens, output_tokens,
 * input_token_details: {text_tokens, audio_tokens}}` — the shape the realtime
 * transcription session's `…completed` events carry when they carry usage at
 * all (inherited from the retired REST endpoint, which reported the same).
 */
export function usageFromTranscription(raw: unknown): Usage | undefined {
  const u = asRecord(raw);
  if (!u || typeof u.input_tokens !== "number") {
    return undefined;
  }
  const details = asRecord(u.input_token_details);
  return {
    input_tokens: u.input_tokens,
    ...(typeof u.output_tokens === "number" ? { output_tokens: u.output_tokens } : {}),
    ...(typeof details?.audio_tokens === "number"
      ? { input_audio_tokens: details.audio_tokens }
      : {}),
  };
}

/**
 * A realtime `response.done` usage → Usage. The GA realtime API reports
 * `{input_tokens, output_tokens, input_token_details: {text_tokens,
 * audio_tokens, cached_tokens}, output_token_details: {text_tokens,
 * audio_tokens}}` — and rebills context every response, which is exactly why
 * per-response accounting matters on the voice path.
 */
export function usageFromRealtimeResponse(raw: unknown): Usage | undefined {
  const u = asRecord(raw);
  if (!u || typeof u.input_tokens !== "number") {
    return undefined;
  }
  const inDetails = asRecord(u.input_token_details);
  const outDetails = asRecord(u.output_token_details);
  return {
    input_tokens: u.input_tokens,
    ...(typeof u.output_tokens === "number" ? { output_tokens: u.output_tokens } : {}),
    ...(typeof inDetails?.audio_tokens === "number"
      ? { input_audio_tokens: inDetails.audio_tokens }
      : {}),
    ...(typeof inDetails?.cached_tokens === "number"
      ? { cache_read_tokens: inDetails.cached_tokens }
      : {}),
    ...(typeof outDetails?.audio_tokens === "number"
      ? { output_audio_tokens: outDetails.audio_tokens }
      : {}),
  };
}

/**
 * A Gemini Live `usageMetadata` → Usage. The Live API reports
 * `{ totalTokenCount, promptTokenCount, responseTokenCount?,
 * promptTokensDetails: [{modality, tokenCount}],
 * responseTokensDetails: [{modality, tokenCount}] }` — the per-turn breakdown
 * the realtime submode's cost trace draws from (google is a supported provider
 * in {@link priceCall}). The per-modality arrays give the audio subsets; the
 * totals come from `promptTokenCount`/`responseTokenCount`, falling back to the
 * summed details (some turns omit the scalar totals). Tolerant like the others:
 * garbage in → undefined out.
 */
export function usageFromGeminiLive(raw: unknown): Usage | undefined {
  const u = asRecord(raw);
  if (!u) {
    return undefined;
  }
  // Sum a `[{modality, tokenCount}]` detail array, and pick out one modality.
  const sumDetails = (list: unknown): number | undefined => {
    if (!Array.isArray(list)) {
      return undefined;
    }
    let total = 0;
    let saw = false;
    for (const entry of list) {
      const e = asRecord(entry);
      if (e && typeof e.tokenCount === "number") {
        total += e.tokenCount;
        saw = true;
      }
    }
    return saw ? total : undefined;
  };
  const modalityTokens = (list: unknown, modality: string): number | undefined => {
    if (!Array.isArray(list)) {
      return undefined;
    }
    for (const entry of list) {
      const e = asRecord(entry);
      if (e && e.modality === modality && typeof e.tokenCount === "number") {
        return e.tokenCount;
      }
    }
    return undefined;
  };
  const promptDetails = u.promptTokensDetails;
  const responseDetails = u.responseTokensDetails;
  const inputTokens =
    typeof u.promptTokenCount === "number" ? u.promptTokenCount : sumDetails(promptDetails);
  if (inputTokens === undefined) {
    return undefined; // nothing priceable — record nothing rather than a phantom call
  }
  const outputTokens =
    typeof u.responseTokenCount === "number" ? u.responseTokenCount : sumDetails(responseDetails);
  const inputAudio = modalityTokens(promptDetails, "AUDIO");
  const outputAudio = modalityTokens(responseDetails, "AUDIO");
  return {
    input_tokens: inputTokens,
    ...(outputTokens !== undefined ? { output_tokens: outputTokens } : {}),
    ...(inputAudio !== undefined ? { input_audio_tokens: inputAudio } : {}),
    ...(outputAudio !== undefined ? { output_audio_tokens: outputAudio } : {}),
  };
}

/**
 * Estimated usage for a TTS call — `/v1/audio/speech` returns raw audio with
 * NO usage object, so the input side is estimated from text length (the
 * standard ≈4 chars/token heuristic) and the audio output goes unpriced
 * (its token count isn't knowable from the response). Callers mark the
 * resulting {@link CallCost} `estimated`; the figure is a floor.
 */
export function estimatedTtsUsage(text: string): Usage {
  return { input_tokens: Math.ceil(text.length / 4) };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}
