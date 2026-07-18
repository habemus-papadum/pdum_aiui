/**
 * The trace-stage label vocabulary — the persisted on-disk contract between the
 * channel (which mints `TraceStage.label` strings into `.aiui-cache/traces`) and
 * every reader of those traces (aiui-trace-ui, the channel's own live narrator).
 *
 * Three layers live here:
 *  1. {@link ParsedStage} — a discriminated union, one variant per label the
 *     channel writes (plus reader-only legacy labels kept so historical traces
 *     render, plus a total `unknown` arm).
 *  2. {@link stageLabel} builders and the {@link parseStageLabel} total parser —
 *     paired so a builder's output always round-trips through the parser, and
 *     the two cannot drift.
 *  3. Per-variant writer data types ({@link StageData}) the channel asserts its
 *     recorded `data` against as compile-time contracts.
 *
 * **These strings are a persisted format, not display text.** Traces already on
 * disk must render forever, so every builder output is pinned char-for-char by a
 * golden test — changing a label's wording orphans history. This module is
 * deliberately INTERNAL vocabulary: it is exported under the clearly-internal
 * `/trace-stages` subpath and carries **no semver promise**. New stage labels
 * are added here without a major bump; consumers pin against a workspace range.
 */

// ── the label alphabet ────────────────────────────────────────────────────────

/** The `chunk.kind` of an input frame (the channel's `ChunkDescriptor` kinds,
 *  plus the retired `video`/`context` kinds historical traces still carry). */
export type FrameChunkKind = "events" | "audio" | "video" | "attachment" | "context" | "control";

/** The realtime vendor-diagnostic kinds interpolated into `stt …` labels — kept
 *  in lockstep with the channel's `RealtimeDiagnostic["kind"]` union at the
 *  writer call site (a compile error there if the two diverge). */
export type SttDiagnosticKind =
  | "config-echo"
  | "config-mismatch"
  | "vendor-commit"
  | "orphan-result"
  | "unhandled";

// ── (1) the parsed-stage union ────────────────────────────────────────────────

/**
 * A trace-stage label, parsed into a discriminated variant. `parseStageLabel`
 * is total: any unrecognized string becomes `{ t: "unknown" }`, so a reader
 * never loses a stage. Templated labels carry their parameters (segment
 * ordinals, attachment ids, cost `what`, diagnostic kinds).
 */
export type ParsedStage =
  // ── the story's frame ──
  | { t: "client-context" }
  | { t: "intent-config" }
  | { t: "prompt-preamble" }
  // ── input frames (`frame N[ kind[ id]][ (fin)]`) ──
  | {
      t: "input-frame";
      n: number;
      chunk?: FrameChunkKind;
      /** For an `attachment` chunk: which media the id names. */
      media?: "shot" | "seg";
      /** The attachment id (`shot_N`/`seg_N`), when present. */
      id?: string;
      fin: boolean;
    }
  // ── server-side lowering (IRs) ──
  | { t: "composed-speculative" }
  | { t: "lowered-prompt-spans" }
  | { t: "merged-events" }
  | { t: "fin-compose" }
  | { t: "composed-intent" }
  | { t: "conditioned" }
  | { t: "lowered-prompt" }
  // ── conditioning + attachments ──
  | { t: "condition"; id: string; kind: "silenceTrim" | "imageDownscale" }
  | { t: "attachment"; id: string; media: "shot" | "seg" }
  // ── realtime session ──
  | { t: "realtime-commit"; segment: number }
  | { t: "realtime-discard"; segment: number }
  | { t: "audio-out-of-order"; id: string }
  // ── stt streaming + vendor diagnostics ──
  | { t: "stt-partial"; segment: number }
  | { t: "stt-final"; segment: number }
  | { t: "stt-vendor-commit"; segment: number }
  | { t: "stt-config-mismatch" }
  | { t: "stt-orphan-result" }
  | { t: "stt-config-echo" }
  | { t: "stt-unhandled" }
  // ── cost + speech ──
  | { t: "cost"; what: string }
  | { t: "speech"; id: string }
  // ── selections ──
  | { t: "app-selection" }
  | { t: "app-selection-dropped" }
  | { t: "code-selection" }
  | { t: "code-selection-dropped" }
  // ── the prompt-linter sidecar ──
  | { t: "linter-open" }
  | { t: "linter-disabled" }
  | { t: "linter-note" }
  | { t: "linter-tool-call"; tool: string }
  | { t: "linter-tool-result" }
  | { t: "linter-transcript"; segment: number }
  | { t: "linter-label"; id: string }
  | { t: "linter-selection" }
  | { t: "linter-selection-retracted" }
  | { t: "linter-turn-end" }
  | { t: "linter-turn-merged" }
  | { t: "linter-interrupted" }
  | { t: "linter-go-away" }
  | { t: "linter-transcript-timeout" }
  | { t: "linter-error" }
  | { t: "linter-close" }
  | { t: "linter-control" }
  // ── unclassified live writer ──
  | { t: "user-text" }
  // ── reader-only LEGACY labels (no living writer; kept so old traces render) ──
  | { t: "correction-request" }
  | { t: "correction-patch" }
  | { t: "correction-failed" }
  | { t: "voice-reply" }
  | { t: "transcription-failed" }
  | { t: "video-legacy" }
  | { t: "live-open" }
  | { t: "live-label"; id: string }
  | { t: "live-nudge" }
  | { t: "live-tool-call" }
  | { t: "live-resolved" }
  | { t: "live-reply" }
  | { t: "live-fallback" }
  // ── the total fallback ──
  | { t: "unknown" };

/** The discriminant tag of a {@link ParsedStage}. */
export type StageTag = ParsedStage["t"];

// ── (2a) the label builders (writers mint through these) ──────────────────────

/**
 * The union of every label the prompt-linter sidecar mints (the templated ones
 * as template-literal types). The sidecar's `record` callback is typed against
 * this, so a new linter label cannot bypass the contract — it fails to typecheck
 * until it is added here and given a builder + parser case.
 */
export type LinterStageLabel =
  | "linter open"
  | "linter disabled"
  | "linter note"
  | "linter tool result"
  | "linter selection"
  | "linter selection retracted"
  | "linter turn end"
  | "linter turn merged"
  | "linter interrupted"
  | "linter go-away"
  | "linter transcript timeout"
  | "linter error"
  | "linter close"
  | "linter control"
  | `linter tool call ${string}`
  | `linter transcript seg_${number}`
  | `linter label ${string}`;

/** Build a `frame …` input label exactly as the tracing decorator did. */
function inputFrameLabel(spec: {
  n: number;
  chunk?: FrameChunkKind;
  id?: string;
  fin?: boolean;
}): string {
  const chunk = spec.chunk
    ? ` ${spec.chunk}${spec.chunk === "attachment" && spec.id !== undefined ? ` ${spec.id}` : ""}`
    : "";
  return `frame ${spec.n}${chunk}${spec.fin ? " (fin)" : ""}`;
}

/**
 * The label builders. Every string the channel writes into a trace is minted
 * here, so the persisted vocabulary lives in one place. Return types are the
 * exact literals/templates, which is what pins the golden test and types the
 * linter callback. Legacy reader-only labels have NO builder — they have no
 * living writer.
 */
export const stageLabel = {
  clientContext: () => "client context" as const,
  intentConfig: () => "intent config" as const,
  promptPreamble: () => "prompt preamble" as const,
  inputFrame: inputFrameLabel,
  composedSpeculative: () => "composed (speculative)" as const,
  loweredPromptSpans: () => "lowered prompt spans" as const,
  mergedEvents: () => "merged events" as const,
  finCompose: () => "fin compose" as const,
  composedIntent: () => "composed intent" as const,
  conditioned: () => "conditioned" as const,
  loweredPrompt: () => "lowered prompt" as const,
  condition: (id: string, kind: "silenceTrim" | "imageDownscale") =>
    `condition ${id} (${kind})` as const,
  attachment: (id: string) => `attachment ${id}` as const,
  realtimeCommit: (segment: number) => `realtime commit seg_${segment}` as const,
  realtimeDiscard: (segment: number) => `realtime discard seg_${segment}` as const,
  audioOutOfOrder: (id: string) => `audio ${id} out-of-order` as const,
  sttPartial: (segment: number) => `stt partial seg_${segment}` as const,
  sttFinal: (segment: number) => `stt final seg_${segment}` as const,
  /** The vendor-diagnostic labels — `stt vendor commit seg_N` or `stt <kind>`. */
  sttDiagnostic: (event: { kind: SttDiagnosticKind; segment?: number }) =>
    event.kind === "vendor-commit"
      ? (`stt vendor commit seg_${event.segment ?? 0}` as const)
      : (`stt ${event.kind}` as const),
  cost: (what: string) => `cost: ${what}` as const,
  speech: (id: string) => `speech ${id}` as const,
  appSelection: () => "app selection" as const,
  appSelectionDropped: () => "app selection dropped" as const,
  codeSelection: () => "code selection" as const,
  codeSelectionDropped: () => "code selection dropped" as const,
  linterOpen: () => "linter open" as const,
  linterDisabled: () => "linter disabled" as const,
  linterNote: () => "linter note" as const,
  linterToolCall: (tool: string) => `linter tool call ${tool}` as const,
  linterToolResult: () => "linter tool result" as const,
  linterTranscript: (segment: number) => `linter transcript seg_${segment}` as const,
  linterLabel: (id: string) => `linter label ${id}` as const,
  linterSelection: () => "linter selection" as const,
  linterSelectionRetracted: () => "linter selection retracted" as const,
  linterTurnEnd: () => "linter turn end" as const,
  linterTurnMerged: () => "linter turn merged" as const,
  linterInterrupted: () => "linter interrupted" as const,
  linterGoAway: () => "linter go-away" as const,
  linterTranscriptTimeout: () => "linter transcript timeout" as const,
  linterError: () => "linter error" as const,
  linterClose: () => "linter close" as const,
  linterControl: () => "linter control" as const,
  userText: () => "user text" as const,
} as const;

// ── (2b) the total parser ─────────────────────────────────────────────────────

/** Exact (non-templated) labels → their variant tag. Drives the parser's
 *  equality tier; the ergonomic builders above mint the same strings. */
const EXACT: Record<string, StageTag> = {
  "client context": "client-context",
  "intent config": "intent-config",
  "prompt preamble": "prompt-preamble",
  "lowered prompt spans": "lowered-prompt-spans",
  "merged events": "merged-events",
  "fin compose": "fin-compose",
  "composed intent": "composed-intent",
  conditioned: "conditioned",
  "lowered prompt": "lowered-prompt",
  "stt config-mismatch": "stt-config-mismatch",
  "stt orphan-result": "stt-orphan-result",
  "stt config-echo": "stt-config-echo",
  "stt unhandled": "stt-unhandled",
  "app selection": "app-selection",
  "app selection dropped": "app-selection-dropped",
  "code selection": "code-selection",
  "code selection dropped": "code-selection-dropped",
  "linter open": "linter-open",
  "linter disabled": "linter-disabled",
  "linter note": "linter-note",
  "linter tool result": "linter-tool-result",
  "linter selection": "linter-selection",
  "linter selection retracted": "linter-selection-retracted",
  "linter turn end": "linter-turn-end",
  "linter turn merged": "linter-turn-merged",
  "linter interrupted": "linter-interrupted",
  "linter go-away": "linter-go-away",
  "linter transcript timeout": "linter-transcript-timeout",
  "linter error": "linter-error",
  "linter close": "linter-close",
  "linter control": "linter-control",
  "user text": "user-text",
  // legacy reader-only:
  "correction request": "correction-request",
  "correction patch": "correction-patch",
  "correction failed": "correction-failed",
  "voice reply": "voice-reply",
  "live open": "live-open",
  "live nudge": "live-nudge",
  "live tool call": "live-tool-call",
  "live resolved": "live-resolved",
  "live reply": "live-reply",
  "live fallback": "live-fallback",
};

/** The trailing attachment id (`shot_N`/`seg_N`) in a label, if any. */
function attachmentIdOf(label: string): string | undefined {
  return /\b(shot_\d+|seg_\d+)\b/.exec(label)?.[1];
}

/** Parse a `frame …` input label into its variant, or null if not one. */
function parseInputFrame(label: string): ParsedStage | null {
  const m = /^frame (\d+)(.*)$/.exec(label);
  if (m === null) {
    return null;
  }
  const n = Number(m[1]);
  let rest = m[2];
  const fin = / \(fin\)$/.test(rest);
  if (fin) {
    rest = rest.replace(/ \(fin\)$/, "");
  }
  rest = rest.replace(/^ /, "");
  // Chunk-kind detection in the reader's precedence order (see the input-frame
  // arm of classifyStage, which maps these back to cards).
  let chunk: FrameChunkKind | undefined;
  let media: "shot" | "seg" | undefined;
  if (rest === "") {
    chunk = undefined;
  } else if (rest.startsWith("events")) {
    chunk = "events";
  } else if (rest.startsWith("audio")) {
    chunk = "audio";
  } else if (rest.startsWith("video")) {
    chunk = "video";
  } else if (rest.startsWith("attachment ")) {
    chunk = "attachment";
    if (rest.startsWith("attachment shot_")) {
      media = "shot";
    } else if (rest.startsWith("attachment seg_")) {
      media = "seg";
    }
  } else if (rest.startsWith("context")) {
    chunk = "context";
  } else if (rest.startsWith("control")) {
    chunk = "control";
  }
  const id = chunk === "attachment" ? attachmentIdOf(label) : undefined;
  return {
    t: "input-frame",
    n,
    ...(chunk !== undefined ? { chunk } : {}),
    ...(media !== undefined ? { media } : {}),
    ...(id !== undefined ? { id } : {}),
    fin,
  };
}

/**
 * Parse a trace-stage label into a {@link ParsedStage}. Total — never throws,
 * always returns a variant ({@link ParsedStage} `unknown` for anything the
 * vocabulary does not recognize). The match order encodes the reader ladder's
 * precedence (templated forms before their exact/generic neighbours).
 */
export function parseStageLabel(label: string): ParsedStage {
  const frame = parseInputFrame(label);
  if (frame !== null) {
    return frame;
  }

  // stt streaming + vendor diagnostics (specific forms before the exact ones).
  let m = /^stt vendor commit seg_(\d+)$/.exec(label);
  if (m) {
    return { t: "stt-vendor-commit", segment: Number(m[1]) };
  }
  m = /^stt partial seg_(\d+)$/.exec(label);
  if (m) {
    return { t: "stt-partial", segment: Number(m[1]) };
  }
  m = /^stt final seg_(\d+)$/.exec(label);
  if (m) {
    return { t: "stt-final", segment: Number(m[1]) };
  }

  // conditioning + attachments.
  m = /^condition (.+) \((silenceTrim|imageDownscale)\)$/.exec(label);
  if (m) {
    return { t: "condition", id: m[1], kind: m[2] as "silenceTrim" | "imageDownscale" };
  }
  if (label.startsWith("attachment shot_")) {
    return { t: "attachment", id: attachmentIdOf(label) ?? "shot", media: "shot" };
  }
  if (label.startsWith("attachment seg_")) {
    return { t: "attachment", id: attachmentIdOf(label) ?? "seg", media: "seg" };
  }

  // realtime session.
  m = /^realtime commit seg_(\d+)$/.exec(label);
  if (m) {
    return { t: "realtime-commit", segment: Number(m[1]) };
  }
  m = /^realtime discard seg_(\d+)$/.exec(label);
  if (m) {
    return { t: "realtime-discard", segment: Number(m[1]) };
  }
  m = /^audio (\S+) out-of-order$/.exec(label);
  if (m) {
    return { t: "audio-out-of-order", id: m[1] };
  }

  // cost + speech.
  m = /^cost: (.+)$/.exec(label);
  if (m) {
    return { t: "cost", what: m[1] };
  }
  m = /^speech (.+)$/.exec(label);
  if (m) {
    return { t: "speech", id: m[1] };
  }

  // linter templated forms (before the exact linter labels).
  m = /^linter tool call (.+)$/.exec(label);
  if (m) {
    return { t: "linter-tool-call", tool: m[1] };
  }
  m = /^linter transcript seg_(\d+)$/.exec(label);
  if (m) {
    return { t: "linter-transcript", segment: Number(m[1]) };
  }
  if (label.startsWith("linter label shot_")) {
    return { t: "linter-label", id: attachmentIdOf(label) ?? "shot" };
  }

  // legacy templated forms.
  if (label.startsWith("live label shot_")) {
    return { t: "live-label", id: attachmentIdOf(label) ?? "shot" };
  }
  if (label.startsWith("video vid_")) {
    return { t: "video-legacy" };
  }
  if (label.startsWith("transcription failed")) {
    return { t: "transcription-failed" };
  }

  // exact labels.
  const exact = EXACT[label];
  if (exact !== undefined) {
    return { t: exact } as ParsedStage;
  }

  // the speculative fold: matched loosely (startsWith) as the reader always has.
  if (label.startsWith("composed (speculative)")) {
    return { t: "composed-speculative" };
  }

  return { t: "unknown" };
}

// ── (3) per-variant writer data types (compile-time contracts) ────────────────

/** `intent config` — the resolved tier/model configuration (no `corrector`). */
export interface IntentConfigData {
  tier: string;
  transcriber: string;
  model: string;
  realtimeModel?: string;
  realtimeDelay?: string;
  audioBack: string;
  ttsModel?: string;
  realtimeVoice?: string;
  linter: string;
  linterModel?: string;
  realtimeReady: boolean;
  speakerReady: boolean;
  summarizerReady: boolean;
  coerced?: unknown;
}

/** `composed (speculative)` — the in-flight fold's transcript/prompt/spans. */
export interface ComposedSpeculativeData {
  transcript: string;
  prompt: string;
  spans: unknown;
}

/** `stt partial seg_N` — the vendor's cumulative revision for a live segment. */
export interface SttPartialData {
  chars: number;
  text: string;
}

/** `realtime commit seg_N` — the committed segment's PCM accounting. */
export interface RealtimeCommitData {
  frames: number;
  bytes: number;
}

/** `realtime discard seg_N` — a sub-floor tap that never transcribed. */
export interface RealtimeDiscardData {
  bytes: number;
  ms: number;
  note: string;
}

/** `audio <id> out-of-order` — a reordered/duplicate audio frame, tolerated. */
export interface AudioOutOfOrderData {
  seq: number;
  lastSeq: number;
  note: string;
}

/** `speech <id>` — a pushed audio clip's shape. */
export interface SpeechData {
  mime: string;
  bytes: number;
  text?: string;
}

/** `condition <id> (silenceTrim|imageDownscale)` — an identity conditioning pass. */
export interface ConditionData {
  identity: true;
}
