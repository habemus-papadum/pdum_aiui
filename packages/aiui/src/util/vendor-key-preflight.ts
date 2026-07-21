/**
 * Vendor-key preflight for `aiui claude` — round TWO of the key story, and
 * deliberately nothing but VALIDITY.
 *
 * Round one (aiui-util's `resolveVendorKeys` + the keys interview) owns
 * discovery: which mode we're in (source: env → vault; installed: vault
 * only), which providers the user skipped, and what value each key resolved
 * to. This module never re-reads the environment or the vault — it takes
 * round one's `ResolvedVendorKeys` verbatim and answers one question per
 * FOUND key: does the vendor accept it?
 *
 * A definitively rejected key (401/403 — and 400 for Gemini's malformed-key
 * shape) FAILS THE LAUNCH: every one of these keys was placed on purpose (an
 * export, an `aiui keys set`, an interview paste), so a rejection means the
 * session the user is about to start is quietly broken — transcription 401s,
 * a Gemini Live socket that closes on open — and the honest move is to stop
 * at the door with the fix in hand, not to boot degraded. The historical
 * trigger is a stale shell export shadowing the real key
 * (archive/workbench/field-notes.md, "Keys & config").
 *
 * Everything short of a rejection stays non-fatal: `missing`/skip degrade the
 * affected tier (round one's interview is where absence gets fixed), and an
 * unconfirmable check (offline, timeout, 5xx/429) is "unverified" — a key we
 * couldn't confirm is not a key we condemn.
 *
 * We record only statuses — never a key or any prefix of one — so the
 * launch-info summary (and the console that renders it) can explain a
 * degraded pipeline without ever seeing a secret.
 */
import type { OpenAiKeyStatus } from "@habemus-papadum/aiui-claude-channel";
import type {
  ResolvedVendorKey,
  ResolvedVendorKeys,
  VendorProvider,
} from "@habemus-papadum/aiui-util";
import { VENDOR_KEYS } from "@habemus-papadum/aiui-util";
import { printError, printNote, printWarning } from "./ui";

export type { OpenAiKeyStatus };

/** One preflight status per provider — the launch-info payload's shape. */
export type VendorKeyStatuses = Record<VendorProvider, OpenAiKeyStatus>;

/** Keep the preflight off the critical path: a slow network can't stall launch. */
const DEFAULT_TIMEOUT_MS = 3000;

/**
 * Each vendor's cheapest authenticated endpoint and the statuses that mean
 * "the key itself was rejected". Gemini answers 400/401/403 depending on how
 * the key is malformed; the others use plain bearer/header auth where only
 * 401/403 condemn the key.
 *
 * `refine` re-reads a condemning response before the verdict sticks —
 * ElevenLabs needs it because RESTRICTED keys (scoped to speech-to-text, the
 * only permission Scribe needs) answer 401 `missing_permissions` on every
 * introspection endpoint, `/v1/user` and `/v1/models` alike (measured
 * 2026-07-21). That 401 is an AUTHENTICATED response — the key is real, it
 * just can't read the account — so it must not fail the launch; only
 * `invalid_api_key` may. This is the one probe that reads a body, and only
 * on a non-2xx.
 */
const PROBES: Record<
  VendorProvider,
  {
    request: (key: string) => { url: string; headers?: Record<string, string> };
    invalid: number[];
    refine?: (res: Response) => Promise<"valid" | "invalid" | "unverified">;
  }
> = {
  openai: {
    request: (key) => ({
      url: "https://api.openai.com/v1/models",
      headers: { authorization: `Bearer ${key}` },
    }),
    invalid: [401, 403],
  },
  gemini: {
    request: (key) => ({
      url: `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`,
    }),
    invalid: [400, 401, 403],
  },
  elevenlabs: {
    request: (key) => ({
      url: "https://api.elevenlabs.io/v1/user",
      headers: { "xi-api-key": key },
    }),
    invalid: [401, 403],
    refine: async (res) => {
      try {
        const body = (await res.json()) as { detail?: { status?: string } };
        if (body.detail?.status === "missing_permissions") {
          return "valid";
        }
        if (body.detail?.status === "invalid_api_key") {
          return "invalid";
        }
      } catch {}
      // An unrecognized rejection shape: don't condemn what we can't identify.
      return "unverified";
    },
  },
};

export interface VendorKeyPreflightOptions {
  /**
   * Perform the authenticated network checks. True only for interactive,
   * non-CI launches (the same gate as the Chrome-for-Testing prompts). When
   * false — CI or any non-interactive session — no network is touched and
   * every found key reports "unverified".
   */
  verify?: boolean;
  /** Injectable for tests; defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Network budget per check (default {@link DEFAULT_TIMEOUT_MS}). */
  timeoutMs?: number;
}

/**
 * Ask one vendor whether it accepts `key`. Never throws, never prints, never
 * returns the key: 2xx → "valid", the probe's condemning statuses →
 * "invalid", anything else (5xx, 429, a network error, or the timeout) →
 * "unverified".
 */
export async function verifyVendorKey(
  provider: VendorProvider,
  key: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<Extract<OpenAiKeyStatus, "valid" | "invalid" | "unverified">> {
  const { fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;
  const probe = PROBES[provider];
  const { url, headers } = probe.request(key);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      ...(headers ? { headers } : {}),
      signal: controller.signal,
    });
    if (res.ok) {
      return "valid";
    }
    if (probe.invalid.includes(res.status)) {
      return probe.refine ? await probe.refine(res) : "invalid";
    }
    return "unverified";
  } catch {
    // Offline, DNS failure, TLS error, or our own abort (timeout): unverified.
    return "unverified";
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Statuses for round one's resolution: a key that resolved to a value is
 * verified (all three in parallel — they share the timeout, not a queue);
 * `skip` and `missing` both report "missing" — no value, nothing to verify
 * (the launch-info vocabulary doesn't distinguish a chosen absence; the
 * reporter below does, via the resolution's `source`).
 */
export async function preflightVendorKeys(
  resolved: ResolvedVendorKeys,
  opts: VendorKeyPreflightOptions = {},
): Promise<VendorKeyStatuses> {
  const { verify = true, fetchImpl, timeoutMs } = opts;
  const statuses = {} as VendorKeyStatuses;
  await Promise.all(
    VENDOR_KEYS.map(async ({ provider }) => {
      const key = resolved[provider].value?.trim();
      if (!key) {
        statuses[provider] = "missing";
      } else if (!verify) {
        statuses[provider] = "unverified";
      } else {
        statuses[provider] = await verifyVendorKey(provider, key, {
          ...(fetchImpl ? { fetchImpl } : {}),
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        });
      }
    }),
  );
  return statuses;
}

interface PreflightMessage {
  level: "error" | "warn" | "note";
  title: string;
  detail: string;
}

/** Where to point the user for a rejected key, by where round one found it. */
function invalidRemedy(key: ResolvedVendorKey): string {
  if (key.source === "env") {
    return (
      "The usual cause is a stale shell export shadowing your real key — check what's " +
      "actually set (this prints only a short prefix, not the whole secret):\n" +
      `  echo $${key.envVar} | head -c 12\n` +
      `Fix the export (or \`unset ${key.envVar}\` to fall back to the OS vault) and relaunch.`
    );
  }
  return (
    "The key came from the OS vault. Replace it and relaunch:\n" + `  aiui keys set ${key.provider}`
  );
}

/**
 * The user-facing message for one provider's preflight, or `null` when
 * there's nothing to say. Valid keys and chosen skips are silent — the
 * launcher's terminal stays quiet until something's actually wrong.
 *
 * Copy is data (not printed here) so it can be unit-tested per case:
 *  - invalid → an ERROR (the caller refuses to launch on any of these);
 *  - missing → the provider's degradation copy (what stops working, how to
 *    add the key) — a warning for the default-path providers, a note for
 *    Gemini, whose absence only parks the opt-in realtime tier;
 *  - unverified → a quiet note, and only when a key was actually found
 *    (an unchecked absence has nothing to report).
 */
export function vendorKeyPreflightMessage(
  key: ResolvedVendorKey,
  status: OpenAiKeyStatus,
): PreflightMessage | null {
  if (key.source === "skip" || status === "valid") {
    return null;
  }
  if (status === "invalid") {
    return {
      level: "error",
      title: `the ${key.label} key was rejected by ${key.label} — refusing to launch`,
      detail:
        `${key.envVar} (from ${key.source === "env" ? "the environment" : "the OS vault"}) ` +
        `isn't valid.\n${invalidRemedy(key)}`,
    };
  }
  if (status === "unverified") {
    if (key.source === "missing") {
      return null;
    }
    return {
      level: "note",
      title: `couldn't verify the ${key.label} key with ${key.label} — continuing`,
      detail:
        "The check didn't complete (offline, a timeout, or a transient vendor error), so the " +
        "key is unverified — not known-bad. Launch continues; if this provider's features turn " +
        "out unavailable, an unreachable or invalid key may be why.",
    };
  }
  // status === "missing", source === "missing": never interviewed (non-interactive
  // launch) or a vault decision whose entry is gone.
  switch (key.provider) {
    case "openai":
      return {
        level: "warn",
        title: "no OpenAI key — the intent pipeline will run degraded",
        detail:
          "Speech transcription and dictation correction are unavailable — the intent client " +
          "says so when you try to dictate. Add the key with `aiui keys set openai` (or, in a " +
          "source checkout, export OPENAI_API_KEY). For offline work, switch the intent client " +
          "to the mock backends.",
      };
    case "gemini":
      return {
        level: "note",
        title: "no Gemini key — the realtime (Gemini Live) tier is unavailable",
        detail:
          "Only the realtime conversational submode needs it; transcription tiers are " +
          "unaffected. Add it with `aiui keys set gemini` (or, in a source checkout, export " +
          "GEMINI_API_KEY).",
      };
    case "elevenlabs":
      return {
        level: "warn",
        title: "no ElevenLabs key — the default transcriber (Scribe) is unavailable",
        detail:
          "Dictation falls back to the OpenAI realtime transcriber (the intent client says so). " +
          "Add the key with `aiui keys set elevenlabs` (or, in a source checkout, export " +
          "ELEVEN_LABS_API_KEY).",
      };
  }
}

/**
 * Print every provider's preflight message and say whether any was fatal.
 * The caller owns what fatal means (`aiui claude` refuses to launch).
 */
export function reportVendorKeyPreflight(
  resolved: ResolvedVendorKeys,
  statuses: VendorKeyStatuses,
): { fatal: boolean } {
  let fatal = false;
  for (const { provider } of VENDOR_KEYS) {
    const message = vendorKeyPreflightMessage(resolved[provider], statuses[provider]);
    if (!message) {
      continue;
    }
    if (message.level === "error") {
      fatal = true;
      printError(message.title, message.detail);
    } else if (message.level === "warn") {
      printWarning(message.title, message.detail);
    } else {
      printNote(message.title, message.detail);
    }
  }
  return { fatal };
}
