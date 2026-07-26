/**
 * pricing.mjs — turn deduped token counts into dollars.
 *
 * Cost is NOT in the transcript (see fields.mjs TRAPS `no-cost-field`), so every
 * dollar figure this project ever shows is a *derived estimate* and must be
 * labelled with the price table that produced it. That is why `priceUnits`
 * returns the table version alongside the number rather than a bare float.
 *
 * Source: LiteLLM's `model_prices_and_context_window.json`, the same table
 * ccusage uses. It is a plain JSON map keyed by model id, with per-token
 * (not per-million) rates:
 *
 *   input_cost_per_token
 *   output_cost_per_token
 *   cache_creation_input_token_cost            ← 5-minute TTL
 *   cache_creation_input_token_cost_above_1hr  ← 1-hour TTL, ~2x the 5m rate
 *   cache_read_input_token_cost
 *
 * The 5m/1h split matters: Claude Code reports the two separately under
 * `message.usage.cache_creation.*`, and a reader that only uses
 * `cache_creation_input_tokens` with the 5m rate under-prices 1h writes.
 */

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { splitModel, UNPRICED_MODELS } from "./fields.mjs";

const LITELLM_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

/**
 * Load the price table, refreshing from LiteLLM at most once a day.
 * Pinned to a local cache file so a run is reproducible offline and so the
 * exact table that produced a number can be archived alongside it.
 */
export async function loadPricing(cacheFile, { maxAgeMs = 864e5, offline = false } = {}) {
  let fresh = false;
  try {
    const s = await stat(cacheFile);
    fresh = Date.now() - s.mtimeMs < maxAgeMs;
  } catch {}
  if (!fresh && !offline) {
    try {
      const res = await fetch(LITELLM_URL, { signal: AbortSignal.timeout(20_000) });
      if (res.ok) {
        const text = await res.text();
        JSON.parse(text); // fail before overwriting a good cache
        await mkdir(path.dirname(cacheFile), { recursive: true });
        await writeFile(cacheFile, text);
      }
    } catch (e) {
      process.stderr.write(`WARN pricing refresh failed (${e.message}); using cache\n`);
    }
  }
  const table = JSON.parse(await readFile(cacheFile, "utf8"));
  const version = (await stat(cacheFile)).mtime.toISOString();
  return { table, version, source: "litellm" };
}

/**
 * Resolve a Claude Code model id to a LiteLLM entry.
 *
 * Claude Code ids are bare (`claude-opus-4-8`) and may carry a bracketed
 * context variant (`claude-opus-4-8[1m]`). LiteLLM keys the same model several
 * ways (bare, `anthropic.`, `us.anthropic.`, …); the bare key is the one that
 * carries first-party Anthropic API pricing, so try it first.
 */
export function resolveModel(table, model) {
  if (!model || UNPRICED_MODELS.has(model)) return undefined;
  const { base, variant } = splitModel(model);
  const candidates = variant ? [`${base}[${variant}]`, `${base}-${variant}`, base] : [base];
  for (const c of candidates) {
    if (table[c]) return { key: c, entry: table[c], variantApplied: c !== base };
  }
  for (const prefix of ["anthropic/", "anthropic.", "us.anthropic.", "global.anthropic."]) {
    if (table[prefix + base])
      return { key: prefix + base, entry: table[prefix + base], variantApplied: false };
  }
  return undefined;
}

/**
 * Price one billable unit (from `fields.billableUnits`).
 * Returns `undefined` when the model has no price entry — callers must surface
 * that rather than silently treating it as $0.
 */
export function priceUnit(table, u) {
  const hit = resolveModel(table, u.model);
  if (!hit) return undefined;
  const e = hit.entry;
  const rate1h =
    e.cache_creation_input_token_cost_above_1hr ?? e.cache_creation_input_token_cost ?? 0;
  const rate5m = e.cache_creation_input_token_cost ?? 0;
  // Prefer the explicit TTL split; fall back to the aggregate when a build
  // predates `cache_creation.*`.
  const cacheCreateCost =
    u.cache5m + u.cache1h > 0 ? u.cache5m * rate5m + u.cache1h * rate1h : u.cacheCreate * rate5m;
  return {
    model: u.model,
    pricedAs: hit.key,
    input: u.input * (e.input_cost_per_token ?? 0),
    output: u.output * (e.output_cost_per_token ?? 0),
    cacheCreate: cacheCreateCost,
    cacheRead: u.cacheRead * (e.cache_read_input_token_cost ?? 0),
    get total() {
      return this.input + this.output + this.cacheCreate + this.cacheRead;
    },
  };
}
