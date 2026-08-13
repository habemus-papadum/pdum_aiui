/**
 * Vendor-key preflight for `aiui claude` — round TWO of the key story, and
 * deliberately nothing but PRESENCE.
 *
 * Round one (aiui-util's `resolveVendorKeys` + the keys interview) owns
 * discovery: which mode we're in (source: env → vault; installed: vault
 * only), which providers the user skipped, and what value each key resolved
 * to. This module never re-reads the environment or the vault — it takes
 * round one's `ResolvedVendorKeys` verbatim and answers one question per
 * provider: did a key resolve at all?
 *
 * Validity is deliberately NOT checked here. This module used to probe each
 * found key against its vendor's cheapest authenticated endpoint, but the
 * probe was removed (2026-08-12): api.openai.com intermittently stalls at
 * time-to-first-byte (measured ~1 in 3 requests from a healthy network,
 * every other vendor endpoint solid), so half the launches printed a
 * spurious "couldn't verify" note about a perfectly good key. A bad key
 * already surfaces loudly at first USE — the intent client's transcription
 * path finalizes the segment with the failure and the per-vendor fix hint
 * (intent-stt.ts's onError; a refused upstream handshake is where a
 * rejected key shows up) — which is also the only moment the answer is
 * guaranteed fresh.
 *
 * A missing key, by contrast, is knowable now and stays worth saying now:
 * each absent provider gets its degradation copy (what stops working, how to
 * add the key). A chosen skip is silent — the user already answered.
 *
 * We record only statuses — never a key or any prefix of one — so the
 * launch-info summary (and the console that renders it) can explain a
 * degraded pipeline without ever seeing a secret.
 */
import type { VendorKeyStatus } from "@habemus-papadum/aiui-claude-channel";
import type {
  ResolvedVendorKey,
  ResolvedVendorKeys,
  VendorProvider,
} from "@habemus-papadum/aiui-util";
import { VENDOR_KEYS } from "@habemus-papadum/aiui-util";
import { printNote, printWarning } from "./ui";

export type { VendorKeyStatus };

/** One presence status per provider — the launch-info payload's shape. */
export type VendorKeyStatuses = Record<VendorProvider, VendorKeyStatus>;

/**
 * Statuses for round one's resolution: a key that resolved to a value is
 * "present"; `skip` and `missing` both report "missing" — no value (the
 * launch-info vocabulary doesn't distinguish a chosen absence; the reporter
 * below does, via the resolution's `source`).
 */
export function vendorKeyStatuses(resolved: ResolvedVendorKeys): VendorKeyStatuses {
  const statuses = {} as VendorKeyStatuses;
  for (const { provider } of VENDOR_KEYS) {
    statuses[provider] = resolved[provider].value?.trim() ? "present" : "missing";
  }
  return statuses;
}

interface PreflightMessage {
  level: "warn" | "note";
  title: string;
  detail: string;
}

/**
 * The user-facing message for one provider's resolution, or `null` when
 * there's nothing to say. Present keys and chosen skips are silent — the
 * launcher's terminal stays quiet until something's actually degraded.
 *
 * Copy is data (not printed here) so it can be unit-tested per case: a
 * missing key gets the provider's degradation copy (what stops working, how
 * to add the key) — a warning for the default-path providers, a note for
 * Gemini, whose absence only parks the opt-in realtime tier.
 */
export function vendorKeyPreflightMessage(key: ResolvedVendorKey): PreflightMessage | null {
  if (key.source !== "missing") {
    return null;
  }
  // source === "missing": never interviewed (non-interactive launch) or a
  // vault decision whose entry is gone.
  switch (key.provider) {
    case "openai":
      return {
        level: "warn",
        title: "no OpenAI key — the intent pipeline will run degraded",
        detail:
          "The oracle and dictation correction are unavailable, and transcription loses its " +
          "OpenAI fallback — the intent client says so when you try. Add the key with " +
          "`aiui keys set openai` (or, in a source checkout, export OPENAI_API_KEY). For " +
          "offline work, switch the intent client to the mock backends.",
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

/** Print every provider's degradation message (missing keys only — present
 * keys and chosen skips are silent). Nothing here is fatal: a keyless launch
 * degrades the affected tier, it doesn't break the session. */
export function reportVendorKeyPreflight(resolved: ResolvedVendorKeys): void {
  for (const { provider } of VENDOR_KEYS) {
    const message = vendorKeyPreflightMessage(resolved[provider]);
    if (!message) {
      continue;
    }
    if (message.level === "warn") {
      printWarning(message.title, message.detail);
    } else {
      printNote(message.title, message.detail);
    }
  }
}
