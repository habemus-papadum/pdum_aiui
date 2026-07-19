/**
 * Hello-config resolution for the `intent-v1` lowering: {@link ResolvedIntent}
 * (the subset of the pipeline config the lowering reads off the hello) plus
 * {@link resolveIntent}, the defensive parse against the shared tier presets and
 * the recorded legacy coercions. Also the config-shaped constants — the stale-key
 * remediation hints and the premium-ack phrase table. A leaf: it imports only the
 * shared pipeline package and the vendor default-model constants.
 *
 * The returned object is deliberately MUTABLE after resolution: the processor
 * coerces `transcriber` again keylessly and the control chunk reassigns `linter`
 * mid-thread, so it must stay one shared object read through, never spread.
 */
import {
  DEFAULT_INTENT_CONFIG,
  expandTier,
  type IntentPipelineConfig,
  type LinterVendor,
  type OracleVendor,
} from "@habemus-papadum/aiui-lowering-pipeline";
import { DEFAULT_GEMINI_LIVE_MODEL } from "./gemini-live";
import { DEFAULT_OPENAI_LIVE_MODEL } from "./openai-live";
import { DEFAULT_REALTIME_MODEL } from "./realtime";

/**
 * The realtime submode's stale-key hint, the Gemini twin of {@link OPENAI_KEY_HINT}.
 * The single most common cause of "the live tier stopped working" is a missing or
 * revoked GEMINI_API_KEY in the channel process's environment — a condition only
 * the server can see, so the server names it.
 */
export const ELEVENLABS_KEY_HINT =
  "If this keeps happening, check the ELEVEN_LABS_API_KEY in the environment the channel " +
  "process was launched from (a missing/stale key fails every Scribe call) — fix it and " +
  "relaunch `aiui claude`, or pick another transcriber (K, then a digit).";

export const GEMINI_KEY_HINT =
  "If this keeps happening, check the GEMINI_API_KEY in the environment the channel " +
  "process was launched from (a missing/stale key fails every Gemini Live call) — fix it and " +
  "relaunch `aiui claude`, or switch to a transcription tier for text-composed prompts.";

/**
 * The premium tier's spoken-ack trigger table, keyed by lowering milestone → the
 * deterministic phrase the channel synthesizes (no LLM). Data-driven so acks are
 * tuneable; v1 ships the minimal recommended set — one send-received ack on a
 * successful `fin` (archive/streaming-turns.md §4). Add a milestone here (and a call site)
 * to speak at another point.
 */
export const ACK_PHRASES: Record<"sent", string> = {
  sent: "sent",
};

/** The subset of `IntentPipelineConfig` the lowering reads off the hello. */
export interface ResolvedIntent {
  /** The cost-sized preset, echoed to the trace (the fine fields below are already expanded). */
  tier: string;
  /**
   * Which submode runs. `transcription` (the default) is document assembly —
   * everything the classic processor does; `realtime` (retired) once held a
   * live conversational session where the MODEL composed — a hello asking for
   * it is coerced to `transcription` plus the prompt linter (see
   * resolveIntent). History: archive/transcription-and-realtime-submodes.md.
   */
  submode: "transcription" | "realtime";
  /** Realtime engine (submode=realtime): the reference `gemini` or degraded `openai`. */
  liveVendor: "gemini" | "openai";
  /** Realtime model id (bare, e.g. `gemini-3.1-flash-live-preview`). */
  liveModel: string;
  transcriber: IntentPipelineConfig["transcriber"];
  model: string;
  /** Domain-vocabulary bias (the keywords slot — see docs/guide/transcription.md). */
  keywords: string[] | undefined;
  /** Realtime transcription model (when transcriber = `openai-realtime`). */
  realtimeModel: string;
  /**
   * Realtime latency/accuracy knob (`minimal`…`xhigh`); undefined → model
   * default. Deliberately WIDENED to `string` (not the config's literal union):
   * resolveIntent passes vendor delay strings through untouched.
   */
  realtimeDelay: string | undefined;
  /** Spoken audio back to the human: `off` | `acks` (premium TTS); `voice` is the retired veneer (treated as off). */
  audioBack: NonNullable<IntentPipelineConfig["audioBack"]>;
  /** REST TTS model for `audioBack:"acks"` (premium). */
  ttsModel: string;
  /** TTS voice id (acks); undefined → the model default. */
  ttsVoice: string | undefined;
  /** The linter's spoken voice id; undefined → the model default. */
  realtimeVoice: string | undefined;
  /** The prompt linter: off, or which live vendor observes the composition. */
  linter: LinterVendor;
  /** Linter model id; undefined → the vendor default. */
  linterModel: string | undefined;
  /** Linter persona override; undefined → LINTER_INSTRUCTIONS. */
  linterInstructions: string | undefined;
  /** The oracle: off, or the live vendor the mic is ADDRESSED to (XOR linter). */
  oracle: OracleVendor;
  /** Oracle model id; undefined → the vendor default. */
  oracleModel: string | undefined;
  /** Oracle persona override; undefined → ORACLE_INSTRUCTIONS. */
  oracleInstructions: string | undefined;
  /** Ambient screen-frame cadence while sharing (ms per frame). */
  videoFrameIntervalMs: number;
  /** Legacy translations applied while resolving (each one human-readable). */
  coerced: string[];
}

/** The premium TTS default model. */
export const DEFAULT_TTS_MODEL = "gpt-4o-mini-tts";

/**
 * The remediation line every OpenAI-backed failure carries on its error push.
 * The single most common cause of "the pipeline stopped working" is a stale or
 * revoked OPENAI_API_KEY in the channel process's environment — a condition
 * only the server can see, so the server names it. Attached unconditionally to
 * OpenAI-seam failures: when the real cause is something else (a network blip,
 * a malformed model reply) the message line already says so, and a hint that
 * doesn't apply costs one sentence.
 */
export const OPENAI_KEY_HINT =
  "If this keeps happening, check the OPENAI_API_KEY in the environment the channel " +
  "process was launched from (a stale key fails every OpenAI call) — fix it and relaunch " +
  "`aiui claude`, or switch to the mock tier for offline work.";

/**
 * Read the fields the lowering uses off the loosely-typed hello `intent`, with
 * defaults. The client sends the fully-expanded effective config, so the fine
 * fields are already concrete; but as a **defensive fallback** for a hello that
 * carries only `tier` (or a sparse partial), each field's default is the tier's
 * preset value — the shared `expandTier` from the pipeline package, so both sides
 * agree on what a tier means (archive/model-tiers.md, "Channel side"). Absent tier →
 * `rapid` (streaming Realtime Whisper — the REST retirement, 2026-07-18);
 * legacy names (standard, flagship, live-*) expand via the shared alias table
 * and their REST/voice choices coerce onto the streaming world below.
 */
export function resolveIntent(raw: unknown): ResolvedIntent {
  const cfg = (raw !== null && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
    typeof value === "string" && (allowed as readonly string[]).includes(value)
      ? (value as T)
      : fallback;
  const str = (value: unknown, fallback: string): string =>
    typeof value === "string" && value !== "" ? value : fallback;
  const optStr = (value: unknown): string | undefined =>
    typeof value === "string" && value !== "" ? value : undefined;
  // The tier's expansion supplies each field's default (below the explicit hello
  // fields), so a `tier`-only hello still resolves concrete seams.
  const tier = str(cfg.tier, "rapid");
  const preset = expandTier(tier);
  const liveVendor = oneOf(
    cfg.liveVendor,
    ["gemini", "openai"] as const,
    preset.liveVendor ?? "gemini",
  );
  const resolved: ResolvedIntent = {
    tier,
    submode: oneOf(
      cfg.submode,
      ["transcription", "realtime"] as const,
      preset.submode ?? "transcription",
    ),
    liveVendor,
    liveModel: str(
      cfg.liveModel,
      preset.liveModel ??
        (liveVendor === "gemini" ? DEFAULT_GEMINI_LIVE_MODEL : DEFAULT_OPENAI_LIVE_MODEL),
    ),
    transcriber: oneOf(
      cfg.transcriber,
      ["mock", "openai", "openai-realtime", "openai-voice", "elevenlabs"] as const,
      preset.transcriber,
    ),
    keywords:
      Array.isArray(cfg.keywords) && cfg.keywords.every((k) => typeof k === "string")
        ? (cfg.keywords as string[])
        : undefined,
    model: str(cfg.model, preset.model),
    realtimeModel: str(cfg.realtimeModel, preset.realtimeModel ?? DEFAULT_REALTIME_MODEL),
    realtimeDelay: optStr(cfg.realtimeDelay ?? preset.realtimeDelay),
    audioBack: oneOf(
      cfg.audioBack,
      ["off", "acks", "voice"] as const,
      preset.audioBack ?? DEFAULT_INTENT_CONFIG.audioBack ?? "off",
    ),
    ttsModel: str(cfg.ttsModel, preset.ttsModel ?? DEFAULT_TTS_MODEL),
    ttsVoice: optStr(cfg.ttsVoice ?? preset.ttsVoice),
    realtimeVoice: optStr(cfg.realtimeVoice ?? preset.realtimeVoice),
    linter: oneOf(cfg.linter, ["off", "openai", "gemini"] as const, preset.linter ?? "off"),
    linterModel: optStr(cfg.linterModel ?? preset.linterModel),
    linterInstructions: optStr(cfg.linterInstructions ?? preset.linterInstructions),
    oracle: oneOf(cfg.oracle, ["off", "openai"] as const, preset.oracle ?? "off"),
    oracleModel: optStr(cfg.oracleModel ?? preset.oracleModel),
    oracleInstructions: optStr(cfg.oracleInstructions ?? preset.oracleInstructions),
    videoFrameIntervalMs:
      typeof cfg.videoFrameIntervalMs === "number" && cfg.videoFrameIntervalMs > 0
        ? cfg.videoFrameIntervalMs
        : (preset.videoFrameIntervalMs ?? 5000),
    coerced: [],
  };
  // ── legacy coercions (the linter pivot) — every translation is recorded ──
  // and lands on the `intent config` trace stage, so a hello that meant the
  // old world shows exactly how it was read into the new one.
  if (resolved.transcriber === "openai-voice") {
    // The flagship voice veneer is retired: transcription is streaming STT,
    // and the spoken companion is the LINTER (which keeps the chosen voice).
    resolved.transcriber = "openai-realtime";
    if (resolved.linter === "off") {
      resolved.linter = "openai";
    }
    resolved.coerced.push(
      "transcriber openai-voice → openai-realtime + linter openai (voice veneer retired)",
    );
  }
  if (resolved.transcriber === "openai") {
    // REST transcription is retired (2026-07-18): transcription is
    // streaming-only. A hello that asked for the per-segment REST engine (an
    // old persisted config, or the legacy `standard` tier's expansion) gets
    // the streaming engine instead.
    resolved.transcriber = "openai-realtime";
    resolved.coerced.push("transcriber openai → openai-realtime (REST transcription retired)");
  }
  if (resolved.submode === "realtime") {
    // The composer submode is retired: the compiler composes everywhere; the
    // live vendor the hello picked becomes the prompt LINTER, keeping the
    // model they chose.
    if (resolved.linter === "off") {
      resolved.linter = resolved.liveVendor;
    }
    if (resolved.linterModel === undefined) {
      resolved.linterModel = resolved.liveModel;
    }
    resolved.submode = "transcription";
    resolved.coerced.push(
      `submode realtime → linter ${resolved.linter} (the model-composes path retired; the compiler composes everywhere)`,
    );
  }
  if (resolved.oracle !== "off" && resolved.linter !== "off") {
    // The journeys' XOR (capture-bus §4): oracle ⊕ linter is structural. The
    // client's config layer enforces it; a hello carrying both anyway (a
    // hand-written config, a race) is coerced — the oracle wins, since it is
    // the more deliberate of the two selections.
    resolved.linter = "off";
    resolved.coerced.push("linter off (oracle on — the journeys' XOR: oracle ⊕ linter)");
  }
  return resolved;
}
