/**
 * OpenAI key preflight for `aiui claude`.
 *
 * Once the multimodal intent modality is the overlay's default, its speech
 * transcription and correction-diff calls need an OpenAI key — and they run in
 * the *channel* process, which inherits the environment `aiui claude` launches
 * in. The adopted key story (see the multimodal-intent-graduation handoff) is
 * deliberately narrow: the key comes from **`OPENAI_API_KEY` in the
 * environment**, never from `config.json` (a shareable, eventually-committed
 * file must not hold secrets) and never from an `aiui claude` flag.
 *
 * So the launcher's whole job is to *preflight* that env var and tell the user
 * what it found — degradation, not refusal. A missing or rejected key never
 * blocks the launch; the modality still mounts, but transcription/correction are
 * unavailable until the key is set (the widget says so — `mock` is the explicit
 * offline choice, not a silent fallback). The most valuable case this catches is the one that
 * bit the bench twice (see workbench field-notes, "Keys & config"): a **stale
 * shell export** shadowing the real key, which surfaces as a confusing 401 deep
 * in the pipeline rather than a clear message up front.
 *
 * We record only a {@link OpenAiKeyStatus} — never the key or any prefix of it —
 * so the launch-info summary (and the DevTools panel that renders it) can
 * explain a degraded pipeline without ever seeing the secret.
 */
import type { OpenAiKeyStatus } from "@habemus-papadum/aiui-claude-channel";
import { printNote, printWarning } from "./ui";

export type { OpenAiKeyStatus };

/** OpenAI's cheapest authenticated endpoint — we read the status, never the body. */
const MODELS_URL = "https://api.openai.com/v1/models";

/** Keep the preflight off the critical path: a slow network can't stall launch. */
const DEFAULT_TIMEOUT_MS = 3000;

export interface PreflightOptions {
  /**
   * Perform the authenticated network check. True only for interactive,
   * non-CI launches (the same gate as the Chrome-for-Testing prompts). When
   * false — CI or any non-interactive session — the check is skipped silently
   * and a present key is reported as "unverified", never contacted.
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
 * Determine the status of `OPENAI_API_KEY` for this launch.
 *
 * Never throws, never prints, never returns the key. Absent env var →
 * "missing". Present but `verify` off → "unverified" (no network touched).
 * Present and verifying → a single `GET /v1/models` with the bearer, read for
 * **status only**: 2xx → "valid", 401/403 → "invalid", anything else (5xx,
 * 429, a network error, or the timeout) → "unverified" — a key we couldn't
 * confirm is not a key we condemn.
 */
export async function preflightOpenAiKey(opts: PreflightOptions = {}): Promise<OpenAiKeyStatus> {
  const {
    verify = true,
    env = process.env,
    fetchImpl = fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = opts;

  const key = env.OPENAI_API_KEY?.trim();
  if (!key) {
    return "missing";
  }
  if (!verify) {
    return "unverified";
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(MODELS_URL, {
      headers: { authorization: `Bearer ${key}` },
      signal: controller.signal,
    });
    if (res.ok) {
      return "valid";
    }
    if (res.status === 401 || res.status === 403) {
      return "invalid";
    }
    // 5xx / 429 / anything else: OpenAI didn't confirm *or* condemn the key.
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
 * nothing to say. A valid key is silent — the launcher's terminal stays quiet
 * until something's actually wrong (the same posture as {@link printNote} &c).
 * The copy is data (not printed here) so it can be unit-tested per case.
 */
export function openAiPreflightMessage(status: OpenAiKeyStatus): PreflightMessage | null {
  switch (status) {
    case "valid":
      return null;
    case "missing":
      return {
        level: "warn",
        title: "OPENAI_API_KEY is not set — the intent pipeline will run degraded",
        detail:
          "Speech transcription and dictation correction are unavailable — the overlay says so when " +
          "you try to dictate. To enable them, export the key in the shell you run `aiui claude` from:\n" +
          "  export OPENAI_API_KEY=sk-…\n" +
          "It flows through to the channel process, which is where those calls happen. (For offline " +
          "work, switch the overlay to the mock backends — see the intent-overlay guide.)",
      };
    case "invalid":
      return {
        level: "warn",
        title:
          "OPENAI_API_KEY was rejected by OpenAI (401) — the intent pipeline will run degraded",
        detail:
          "The key in your environment isn't valid. The usual cause is a stale shell export " +
          "shadowing your real key — check what's actually set (this prints only a short prefix, " +
          "not the whole secret):\n" +
          "  echo $OPENAI_API_KEY | head -c 12\n" +
          "and compare that against the start of your real key. Until it's fixed, transcription " +
          "and correction are unavailable.",
      };
    case "unverified":
      return {
        level: "note",
        title: "couldn't verify OPENAI_API_KEY with OpenAI — continuing",
        detail:
          "The check didn't complete (offline, a timeout, or a transient OpenAI error), so the " +
          "key is unverified — not known-bad. Launch continues; if transcription and correction " +
          "turn out unavailable, an unreachable or invalid key may be why.",
      };
  }
}

/** Print the preflight message for `status` (nothing, for a valid key). */
export function reportOpenAiPreflight(status: OpenAiKeyStatus): void {
  const message = openAiPreflightMessage(status);
  if (!message) {
    return;
  }
  if (message.level === "warn") {
    printWarning(message.title, message.detail);
  } else {
    printNote(message.title, message.detail);
  }
}
