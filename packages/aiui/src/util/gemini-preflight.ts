/**
 * Gemini key preflight for `aiui claude` — the GEMINI_API_KEY twin of
 * {@link ./openai-preflight}.
 *
 * The realtime submode's reference engine is Gemini Live, and it runs in the
 * *channel* process, which inherits the environment `aiui claude` launches in.
 * Same key story as OpenAI: **`GEMINI_API_KEY` in the environment**, never
 * config, never a flag. And the same failure this catches: a missing or stale
 * key that would otherwise surface as an opaque closed WebSocket deep in a
 * live session ("gemini live session closed") rather than a clear message up
 * front. Degradation, not refusal — a bad key never blocks the launch; the
 * realtime tier is simply unavailable until it's fixed.
 *
 * We record only a status — never the key or any prefix of it — so the
 * launch-info summary can explain a degraded pipeline without seeing the
 * secret.
 */
import type { OpenAiKeyStatus } from "@habemus-papadum/aiui-claude-channel";
import { printNote, printWarning } from "./ui";

/** Gemini's cheapest authenticated endpoint — we read the status, never the body. */
const MODELS_URL = "https://generativelanguage.googleapis.com/v1beta/models";

/** Keep the preflight off the critical path: a slow network can't stall launch. */
const DEFAULT_TIMEOUT_MS = 3000;

export interface GeminiPreflightOptions {
  /**
   * Perform the authenticated network check. True only for interactive,
   * non-CI launches. When false the check is skipped silently and a present
   * key is reported as "unverified", never contacted.
   */
  verify?: boolean;
  /** Injectable for tests; defaults to the process environment. */
  env?: NodeJS.ProcessEnv;
  /** Injectable for tests; defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Network budget for the status check (default {@link DEFAULT_TIMEOUT_MS}). */
  timeoutMs?: number;
}

/**
 * Determine the status of `GEMINI_API_KEY` for this launch. Same contract as
 * `preflightOpenAiKey`: never throws, never prints, never returns the key.
 * The key rides the query string (Gemini's auth shape — no bearer header) and
 * a rejected key answers 400/401/403 depending on how it's malformed, so all
 * three read as "invalid".
 */
export async function preflightGeminiKey(
  opts: GeminiPreflightOptions = {},
): Promise<OpenAiKeyStatus> {
  const {
    verify = true,
    env = process.env,
    fetchImpl = fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = opts;

  const key = env.GEMINI_API_KEY?.trim();
  if (!key) {
    return "missing";
  }
  if (!verify) {
    return "unverified";
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${MODELS_URL}?key=${encodeURIComponent(key)}`, {
      signal: controller.signal,
    });
    if (res.ok) {
      return "valid";
    }
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      return "invalid";
    }
    // 5xx / 429 / anything else: Google didn't confirm *or* condemn the key.
    return "unverified";
  } catch {
    // Offline, DNS failure, TLS error, or our own abort (timeout): unverified.
    return "unverified";
  } finally {
    clearTimeout(timer);
  }
}

interface PreflightMessage {
  level: "warn" | "note";
  title: string;
  detail: string;
}

/**
 * The user-facing message for a preflight status, or `null` when there's
 * nothing to say. Unlike the OpenAI twin, a **missing** Gemini key is a quiet
 * `note`, not a warning: the default transcription tiers don't need it — only
 * the realtime (Gemini Live) submode does — so its absence degrades one
 * opt-in tier, not the pipeline's default path.
 */
export function geminiPreflightMessage(status: OpenAiKeyStatus): PreflightMessage | null {
  switch (status) {
    case "valid":
      return null;
    case "missing":
      return {
        level: "note",
        title: "GEMINI_API_KEY is not set — the realtime (Gemini Live) tier is unavailable",
        detail:
          "Only the realtime conversational submode needs it; transcription tiers are unaffected. " +
          "To enable it, export the key in the shell you run `aiui claude` from:\n" +
          "  export GEMINI_API_KEY=…\n" +
          "It flows through to the channel process, where the Gemini Live session runs.",
      };
    case "invalid":
      return {
        level: "warn",
        title: "GEMINI_API_KEY was rejected by Google — the realtime tier will fail",
        detail:
          "The key in your environment isn't valid, so every Gemini Live session will close " +
          "immediately. The usual cause is a stale shell export shadowing your real key — check " +
          "what's actually set (this prints only a short prefix, not the whole secret):\n" +
          "  echo $GEMINI_API_KEY | head -c 8\n" +
          "Fix the export and relaunch `aiui claude`.",
      };
    case "unverified":
      return {
        level: "note",
        title: "couldn't verify GEMINI_API_KEY with Google — continuing",
        detail:
          "The check didn't complete (offline, a timeout, or a transient error), so the key is " +
          "unverified — not known-bad. Launch continues; if the realtime tier turns out " +
          "unavailable, an unreachable or invalid key may be why.",
      };
  }
}

/** Print the preflight message for `status` (nothing, for a valid key). */
export function reportGeminiPreflight(status: OpenAiKeyStatus): void {
  const message = geminiPreflightMessage(status);
  if (!message) {
    return;
  }
  if (message.level === "warn") {
    printWarning(message.title, message.detail);
  } else {
    printNote(message.title, message.detail);
  }
}
