/**
 * cost.ts — what a session has spent, priced as it goes.
 *
 * Prices come from [@pydantic/genai-prices](https://github.com/pydantic/genai-prices),
 * the same catalog the channel's lowering pipeline uses — a maintained
 * multi-provider table whose `Usage` shape is natively multimodal and whose
 * data ships with the package. A hardcoded rate table was the alternative and
 * is strictly worse: realtime audio and text differ by ~8× per token, the
 * numbers move, and a stale constant would be wrong silently.
 *
 * Two properties matter more than the arithmetic, both inherited deliberately
 * from `aiui-claude-channel/src/cost.ts`:
 *
 *  - **It never throws.** `calcPrice` validates aggressively (audio subsets
 *    must not exceed their totals, and providers report them inconsistently),
 *    and a pricing hiccup must never disturb a live conversation.
 *  - **Unknown models still account.** The catalog lags brand-new models, and
 *    `gpt-realtime-2.1` may well be one — those responses report their token
 *    usage with no `usd`, and the UI shows the count as UNPRICED rather than
 *    folding a silent zero into a running total. A cost display that
 *    under-reports without saying so is worse than none.
 *
 * DUPLICATION, deliberate and bounded: `usageFromRealtimeResponse` also exists
 * in `aiui-claude-channel/src/cost.ts`, which maps four vendor dialects for the
 * server-side pipeline. The two must agree. They are not shared because the
 * dependency would run the wrong way — the channel is a server, this is a
 * browser widget library that carries solid-js — and because the realtime wire
 * shape is this package's own domain knowledge. If a third consumer appears,
 * that is the signal to extract it rather than copy it again.
 */

import { calcPrice, type Usage } from "@pydantic/genai-prices";

export type { Usage } from "@pydantic/genai-prices";

/**
 * A realtime `response.done` usage → the genai-prices `Usage` shape.
 *
 * The vendor reports `{ input_tokens, output_tokens, input_token_details:
 * { text_tokens, audio_tokens, cached_tokens }, output_token_details:
 * { text_tokens, audio_tokens } }` — where the per-modality figures are
 * SUBSETS of the totals, which is also genai-prices' convention, so this is
 * mostly a rename. Tolerant: garbage in → undefined out, and the response goes
 * unaccounted rather than unprocessed.
 */
export function usageFromRealtimeResponse(raw: unknown): Usage | undefined {
  const usage = asRecord(raw);
  if (usage === undefined || typeof usage.input_tokens !== "number") {
    return undefined;
  }
  const input = asRecord(usage.input_token_details);
  const output = asRecord(usage.output_token_details);
  return {
    input_tokens: usage.input_tokens,
    ...(typeof usage.output_tokens === "number" ? { output_tokens: usage.output_tokens } : {}),
    ...(typeof input?.audio_tokens === "number" ? { input_audio_tokens: input.audio_tokens } : {}),
    ...(typeof input?.cached_tokens === "number" ? { cache_read_tokens: input.cached_tokens } : {}),
    // The cached AUDIO subset, which must travel separately or the whole
    // response goes unpriced. genai-prices' accounting identity is
    // `uncached_text = input − input_audio − (cache_read − cache_audio_read)`,
    // and it REJECTS a negative — so folding cached audio into `cache_read`
    // alone throws the moment a conversation has any audio history, which is
    // immediately. (`aiui-claude-channel/src/cost.ts` does exactly that and so
    // silently prices realtime responses at nothing; measured 2026-07-31.)
    // It matters: on a representative turn the split gives $0.0583 where
    // dropping the cache credit entirely gives $0.1616 — a 2.8× error.
    ...(typeof asRecord(input?.cached_tokens_details)?.audio_tokens === "number"
      ? {
          cache_audio_read_tokens: (
            asRecord(input?.cached_tokens_details) as Record<string, number>
          ).audio_tokens,
        }
      : {}),
    ...(typeof output?.audio_tokens === "number"
      ? { output_audio_tokens: output.audio_tokens }
      : {}),
  };
}

/**
 * Candidate catalog ids for a model, most specific first.
 *
 * The catalog matches exact ids, and ours is `gpt-realtime-2.1`, which it does
 * not carry — only `gpt-realtime`. Rather than show every session as unpriced,
 * trailing version segments are trimmed and the result is flagged APPROXIMATE:
 * a point release usually shares its base model's rates, but "usually" is not
 * "verified", so the number wears a `~` and says why.
 *
 * Stops at two segments so a trim can never reach something generic enough to
 * match the wrong family (`gpt-realtime` must not degrade to `gpt`).
 */
export function priceCandidates(model: string): string[] {
  const out = [model];
  const parts = model.split("-");
  while (parts.length > 2) {
    parts.pop();
    out.push(parts.join("-"));
  }
  return out;
}

/** What pricing one response yielded. `undefined` = the catalog had no answer,
 * which the caller must carry as "unpriced", never as zero. */
export interface PricedUsage {
  usd: number;
  /** The catalog id that answered — differs from the model asked for when a
   * version suffix had to be trimmed. */
  pricedAs: string;
  /** True when `pricedAs` is not the model actually in use. */
  approximate: boolean;
}

export function priceRealtimeUsage(model: string, usage: Usage): PricedUsage | undefined {
  // Audio subsets may not exceed their totals; a transport that omits a total
  // would otherwise be rejected outright, so raise the total to cover it.
  const normalized: Usage = { ...usage };
  if (normalized.input_audio_tokens !== undefined) {
    normalized.input_tokens = Math.max(normalized.input_tokens ?? 0, normalized.input_audio_tokens);
  }
  if (normalized.output_audio_tokens !== undefined) {
    normalized.output_tokens = Math.max(
      normalized.output_tokens ?? 0,
      normalized.output_audio_tokens,
    );
  }
  for (const candidate of priceCandidates(model)) {
    try {
      const priced = calcPrice(normalized, candidate, { providerId: "openai" });
      const usd = priced?.total_price;
      if (typeof usd === "number" && Number.isFinite(usd)) {
        return { usd, pricedAs: candidate, approximate: candidate !== model };
      }
    } catch {
      // A validation refusal is not a reason to try a different id — the usage
      // is what it rejected, not the model. Stop rather than fish.
      return undefined;
    }
  }
  return undefined;
}

/** `13.2k`, `1.4M` — a token count at a glance. Small numbers stay exact:
 * rounding 47 to "0.0k" would hide the thing you are watching for. */
export function abbreviateTokens(count: number): string {
  if (count < 1_000) {
    return String(count);
  }
  if (count < 1_000_000) {
    const thousands = count / 1_000;
    return `${thousands < 100 ? thousands.toFixed(1) : Math.round(thousands)}k`;
  }
  return `${(count / 1_000_000).toFixed(count < 10_000_000 ? 2 : 1)}M`;
}

/**
 * A running total in dollars, at a precision that stays useful across four
 * orders of magnitude — a voice session starts in tenths of a cent and can
 * reach dollars, and `$0.00` for the first several minutes would read as
 * "free" rather than "small".
 */
export function formatUsd(usd: number): string {
  if (usd === 0) {
    return "$0";
  }
  if (usd < 0.01) {
    return `$${usd.toFixed(4)}`;
  }
  if (usd < 1) {
    return `$${usd.toFixed(3)}`;
  }
  return `$${usd.toFixed(2)}`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}
