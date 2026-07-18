/**
 * turn-config.ts — the two pure, DOM-free lane primitives: the intent-config
 * mapping declared on every hello (panelIntentConfig) and the compose/replay
 * unit (currentThreadEvents). Leaf module — imports only the lowering pipeline.
 */

import {
  DEFAULT_INTENT_CONFIG,
  expandTier,
  type IntentEvent,
  type IntentPipelineConfig,
} from "@habemus-papadum/aiui-lowering-pipeline";

/**
 * The effective intent config, declared on every hello (salvaged verbatim
 * from the retired extension panel's turn.ts — model names on the surface,
 * shared tiers underneath).
 */
export function panelIntentConfig(sttName: string, linterName?: string): IntentPipelineConfig {
  const base =
    sttName === "scribe-v2"
      ? { ...expandTier("premium"), transcriber: "elevenlabs" as const }
      : sttName === "gpt-4o-transcribe"
        ? { ...expandTier("premium"), model: "gpt-4o-transcribe" }
        : sttName === "gpt-4o-mini-transcribe"
          ? expandTier("premium")
          : expandTier("rapid");
  return {
    ...DEFAULT_INTENT_CONFIG,
    ...base,
    // No spoken "sent" ack, whatever the tier (owner, 2026-07-16): the premium
    // preset bundles audioBack:"acks" with its STT, but the panel confirms a
    // send VISUALLY (status line + preview) — a voice saying "sent" is noise.
    // Server-side this also skips the TTS seam entirely. The LINTER's spoken
    // notes are unaffected: their clips gate on `linter`, never `audioBack`
    // (the silent-linter rule, shell/wire.ts).
    audioBack: "off" as const,
    ...(linterName !== undefined && linterName !== "off" ? { linter: linterName as never } : {}),
  };
}

/** The events since the last thread-open — the compose/replay unit. */
export function currentThreadEvents(events: readonly IntentEvent[]): IntentEvent[] {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === "thread-open") {
      return events.slice(i);
    }
  }
  return [];
}
