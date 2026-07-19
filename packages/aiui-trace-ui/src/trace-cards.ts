/**
 * Trace → cards: the pure classification/coalescing/parsing layer under the
 * {@link TraceView}'s card-based reading surface.
 *
 * The trace view stopped being a wall of per-stage JSON trees and became a
 * *story* you can read top-to-bottom: a status header, the lowered prompt as a
 * hero, and the recorded stages as compact, directional, filterable cards. All
 * the logic that decides *what a stage is* — which lane it belongs in, which
 * icon and title it wears, whether a run of near-identical stages collapses into
 * one card, how a V4A patch splits into diff lines, where a lowered prompt's
 * preamble ends and its body begins — lives here, as pure functions with no DOM,
 * so it is unit-tested in isolation and the DOM layer stays a thin renderer.
 *
 * The classification is driven off the channel's stage *labels* (see the
 * `trace?.record({ label })` call sites in the channel's intent-v1.ts) rather
 * than a shared enum: the debug UI is deliberately decoupled from the channel
 * package, and a label the classifier doesn't recognize simply falls through to
 * a sensible generic card instead of breaking the view. That keeps a new stage
 * type visible the day it's added, before anyone teaches this file about it.
 */
import type { IntentEvent, PromptSpan } from "@habemus-papadum/aiui-lowering-pipeline";
import {
  type ParsedStage,
  parseStageLabel,
} from "@habemus-papadum/aiui-lowering-pipeline/trace-stages";
import type { TraceStageLike } from "./sources";

/**
 * The lane a card sits in, coloured and arrowed at the card's left edge. The
 * vantage point is **the browser** — arrows point the way the message moved
 * relative to the reader:
 * The vantage point is **the browser**:
 *  - `in` — the browser SENT it (input frames, correction requests): blue, `←`.
 *  - `out` — the browser RECEIVED it (echoes, patches, pushes): green, `→`.
 *  - `agent` — the lowered prompt leaving for the Claude session: purple, `←`.
 *  - `internal` — the prompt compiler's own work (config resolution,
 *    preambles, composes — the IRs only the trace can show). These aren't
 *    turn messages, but they DO arrive at the reader as the server's report
 *    of what it computed: yellow, `→`, labelled "lowering" in the chips.
 * Errors render red and point `→` — they come back to us from the server.
 */
export type CardDirection = "in" | "out" | "agent" | "internal";

/**
 * The filter bucket a card answers to. Seven are user-togglable (the chips);
 * three — `context`, `config`, `lowered` — are the story's frame and always show
 * (only the direction filter can hide them). `errors` is its own bucket so a
 * "show me only what went wrong" pass is one toggle, and failure stages are
 * routed here rather than to their nominal lane.
 */
export type CardCategory =
  | "context"
  | "config"
  | "wire"
  | "events"
  | "audio"
  | "video"
  | "media"
  | "compose"
  | "corrections"
  | "linter"
  | "speech"
  | "cost"
  | "errors"
  | "lowered";

/** The togglable filter buckets, in chip order. */
export const TOGGLE_CATEGORIES: readonly CardCategory[] = [
  "wire",
  "events",
  "audio",
  "video",
  "media",
  "compose",
  "corrections",
  "linter",
  "speech",
  "cost",
  "errors",
];

/** Buckets that always render (the direction filter still applies). */
export const ALWAYS_CATEGORIES: readonly CardCategory[] = ["context", "config", "lowered"];

/**
 * The buckets hidden by default: speculative composes and per-frame audio are
 * the noisiest internal chatter (a real turn records them by the hundred),
 * per-frame `video` is the realtime submode's flood (a live turn streams it at
 * ~1fps for the whole conversation), and the `wire` bucket is the raw
 * event-frame receipts — blob pointers whose decoded content the `merged
 * events` card already tells better. Off by default, the remaining cards read
 * like a story; one chip brings them back.
 */
export const DEFAULT_HIDDEN: readonly CardCategory[] = ["audio", "video", "compose", "wire"];

/** The toggle buckets enabled on first render (all but {@link DEFAULT_HIDDEN}). */
export function defaultEnabledCategories(): Set<CardCategory> {
  return new Set(TOGGLE_CATEGORIES.filter((c) => !DEFAULT_HIDDEN.includes(c)));
}

/** Icon + short label per bucket — the filter chips and card icons share these. */
export const CATEGORY_META: Record<CardCategory, { icon: string; label: string }> = {
  context: { icon: "🌐", label: "context" },
  config: { icon: "⚙", label: "config" },
  wire: { icon: "📦", label: "wire" },
  events: { icon: "📜", label: "events" },
  audio: { icon: "🎙", label: "audio" },
  video: { icon: "🎞", label: "video" },
  media: { icon: "🖼", label: "media" },
  compose: { icon: "🧮", label: "compose" },
  corrections: { icon: "🩹", label: "fixes" },
  linter: { icon: "💡", label: "linter" },
  speech: { icon: "🔊", label: "speech" },
  cost: { icon: "💰", label: "cost" },
  errors: { icon: "⚠", label: "errors" },
  lowered: { icon: "🚀", label: "prompt" },
};

/** How one stage classifies before coalescing. */
export interface StageClass {
  direction: CardDirection;
  category: CardCategory;
  /** A card-specific glyph (may differ from the bucket's, e.g. `✅` vs `🩹`). */
  icon: string;
  /** The bold short title. */
  title: string;
  /** Failure/degradation stage — rendered red regardless of bucket. */
  error: boolean;
  /**
   * Non-null → consecutive stages sharing this key collapse into one card.
   * Null → never coalesced (each stage is its own card).
   */
  coalesceKey: string | null;
}

/** One rendered card: a classified stage (or a coalesced run of them). */
export interface TraceCard extends StageClass {
  /** The covered stage indices, in order (length > 1 when coalesced). */
  indices: number[];
  /** The representative stage — the *last* of a run, so the freshest shows. */
  stage: TraceStageLike;
  /** The representative stage's parsed label — the renderer switches on this. */
  parsed: ParsedStage;
  /** The run length (1 when not coalesced). */
  count: number;
}

const norm = (
  direction: CardDirection,
  category: CardCategory,
  icon: string,
  title: string,
): StageClass => ({ direction, category, icon, title, error: false, coalesceKey: null });

const fail = (direction: CardDirection, icon: string, title: string): StageClass => ({
  direction,
  category: "errors",
  icon,
  title,
  error: true,
  coalesceKey: null,
});

/**
 * The generic fallback card, keyed off the stage `kind` — where an unrecognized
 * label lands so nothing is ever dropped from the view. This is also where a
 * handful of KNOWN-DRIFT labels land today (see the switch below): the channel
 * writes them, but no classifier case ever claimed them.
 */
function genericFallback(stage: TraceStageLike): StageClass {
  const label = stage.label ?? "";
  switch (stage.kind) {
    case "input":
      return norm("in", "events", "•", label || "input");
    case "output":
      return norm("out", "lowered", "•", label || "output");
    case "ir":
      return norm("internal", "compose", "•", label || "ir");
    default:
      return norm("internal", "config", "•", label || "info");
  }
}

/**
 * Classify one stage into its lane, bucket, icon, and title. Parses the label
 * once (the shared trace-stage vocabulary) and switches on the variant — total
 * over unknown labels, which land on {@link genericFallback}. The switch is
 * exhaustive by construction (a `never` check catches an unhandled variant at
 * compile time).
 */
export function classifyStage(stage: TraceStageLike): StageClass {
  return classifyParsed(parseStageLabel(stage.label ?? ""), stage);
}

function classifyParsed(parsed: ParsedStage, stage: TraceStageLike): StageClass {
  switch (parsed.t) {
    // ── the story's frame ────────────────────────────────────────────────────
    case "client-context":
      return norm("in", "context", "🌐", "client context");
    case "intent-config":
      return norm("internal", "config", "⚙", "intent config");
    case "prompt-preamble":
      return norm("internal", "context", "🧩", "prompt preamble");

    // ── the client → server wire (input frames) ──────────────────────────────
    // The chunk-kind precedence the old regex ladder encoded: kind wins over the
    // fin flag (an events frame with a fin still reads as event frames), and fin
    // wins over a bare frame.
    case "input-frame": {
      if (parsed.chunk === "events") {
        // The raw wire receipt of an event batch — the stage holds only a blob
        // pointer (input-N.bin); the decoded story lives in `merged events`.
        return { ...norm("in", "wire", "📦", "event frames"), coalesceKey: "wire-events" };
      }
      if (parsed.chunk === "audio") {
        return { ...norm("in", "audio", "🎙", "audio stream"), coalesceKey: "audio-in" };
      }
      if (parsed.chunk === "video") {
        // The realtime submode's ~1fps live-session video. Coalesced like audio
        // into one card (its own `video-in` key, so an audio↔video interleave
        // splits into distinct cards), hidden behind the `video` chip.
        return { ...norm("in", "video", "🎞", "video stream"), coalesceKey: "video-in" };
      }
      if (parsed.chunk === "attachment" && parsed.media === "shot") {
        return norm("in", "media", "🖼", `${parsed.id ?? "shot"} uploaded`);
      }
      if (parsed.chunk === "attachment" && parsed.media === "seg") {
        return norm("in", "audio", "🎙", `${parsed.id ?? "seg"} uploaded`);
      }
      if (parsed.chunk === "context") {
        return norm("in", "context", "🧭", "selection context");
      }
      if (parsed.fin) {
        return norm("in", "events", "🏁", "fin — commit");
      }
      return { ...norm("in", "wire", "📦", "frames"), coalesceKey: "wire-events" };
    }

    // ── server-side lowering (IRs) ───────────────────────────────────────────
    case "composed-speculative":
      return { ...norm("internal", "compose", "🧮", "speculative compose"), coalesceKey: "spec" };
    case "lowered-prompt-spans":
      // The sent prompt's PromptSpan annotations — the hero's overlay data.
      return norm("internal", "compose", "📐", "prompt spans");
    case "condition":
      return parsed.kind === "silenceTrim"
        ? norm("internal", "audio", "⚙", `condition · silence-trim · ${parsed.id}`)
        : norm("internal", "media", "⚙", `condition · downscale · ${parsed.id}`);
    case "attachment":
      return parsed.media === "seg"
        ? norm("internal", "audio", "🔊", `${parsed.id} · audio`)
        : norm("internal", "media", "🖼", `${parsed.id} · screenshot`);
    case "realtime-commit":
      return norm("internal", "audio", "⚙", `realtime commit · seg_${parsed.segment}`);
    case "cost":
      // A model call's spend (channel cost.ts): 💰, its own filter bucket, the
      // internal lane — money is a server-side fact about the turn.
      return norm("internal", "cost", "💰", parsed.what);

    // The correction trio all crosses the wire: the request arrived FROM the
    // browser, the patch (or the failure) was pushed BACK to it — real messages,
    // not lowering work, so they ride the directional lanes.
    case "correction-request":
      return norm("in", "corrections", "🩹", "correction request");
    case "correction-patch":
      return norm("out", "corrections", "✅", "correction patch");
    case "correction-failed":
      return fail("out", "❌", "correction failed");

    // Selections are first-class stages ("did my selection make it in?"): both
    // kinds arrive FROM the browser (in lane), on the always-shown context
    // bucket. The drop stages are the chips' ✕ — same lane, same bucket.
    case "app-selection":
      return norm("in", "context", "⌖", "app selection");
    case "app-selection-dropped":
      return norm("in", "context", "⌖", "app selection dropped");
    case "code-selection":
      return norm("in", "context", "⧉", "code selection");
    case "code-selection-dropped":
      return norm("in", "context", "⧉", "code selection dropped");

    // ── vendor-protocol diagnostics (the realtime sessions' onDiagnostic) ─────
    case "stt-vendor-commit":
      // The vendor closed an utterance we never asked it to close. Not an error —
      // but the reason a segment's transcript is a concatenation.
      return norm("out", "events", "✂", `vendor commit seg_${parsed.segment}`);
    case "stt-config-mismatch":
      // A param the server did not confirm — we are not running the protocol we
      // think we are.
      return fail("out", "⚠", "stt config-mismatch");
    case "stt-orphan-result":
      // A finished transcript that matched no segment at all.
      return fail("out", "⚠", "stt orphan-result");
    case "stt-config-echo":
      return norm("out", "config", "🔎", "stt config echo");
    case "stt-unhandled":
      return norm("out", "events", "👽", "stt unhandled message");
    case "stt-partial":
      // One card per vendor revision, deliberately NOT coalesced: the sequence is
      // the diagnostic. Each renders as a diff against the segment's previous
      // partial, so a cumulative transcript that shrinks shows up as red.
      return norm("internal", "events", "✍", `stt partial seg_${parsed.segment}`);
    case "stt-final":
      // The per-final capability receipt: words / timestamps / logprob range at
      // a glance (the heat-map debugging lesson).
      return norm("internal", "events", "📝", `stt final seg_${parsed.segment}`);

    case "merged-events":
      return norm("internal", "events", "📜", "merged events");
    case "fin-compose":
      return norm("internal", "compose", "⚙", "fin compose");
    case "composed-intent":
      return norm("internal", "compose", "🧮", "composed intent");
    case "conditioned":
      return norm("internal", "compose", "🧮", "conditioned");

    // ── server → client / the agent ──────────────────────────────────────────
    case "lowered-prompt":
      // The one message that leaves the pipeline entirely: purple, ← (away).
      return norm("agent", "lowered", "🚀", "lowered prompt");
    case "speech":
      return norm("out", "speech", "🔊", "speech");
    case "voice-reply":
      return norm("out", "speech", "🗣", "voice reply");

    // ── the prompt linter (the live sidecar) ─────────────────────────────────
    // The vantage stays the browser↔server pipeline, one conversation further
    // upstream: `in`/blue is what WE feed the linter (transcripts, labels,
    // selections, tool results); `out`/green is what it answers (notes, tool
    // calls). All on the 💡 bucket so "what did the linter see/say?" is one chip.
    case "linter-open":
      return norm("internal", "config", "💡", "linter open");
    case "linter-disabled":
      return fail("internal", "⚠", "linter disabled");
    case "linter-note":
      return norm("out", "linter", "💡", "linter note");
    case "linter-tool-call":
      return norm("out", "linter", "🛠", `linter → ${parsed.tool}`);
    case "linter-tool-result":
      return norm("in", "linter", "📄", "tool result → linter");
    case "linter-transcript":
      return norm("in", "linter", "📝", `transcript seg_${parsed.segment}`);
    case "linter-label":
      return norm("in", "linter", "🏷", `${parsed.id} shown to linter`);
    case "linter-selection":
      return norm("in", "linter", "⌖", "linter selection");
    case "linter-selection-retracted":
      return norm("in", "linter", "⌖", "linter selection retracted");
    case "linter-turn-end":
      return { ...norm("internal", "linter", "💡", "linter turn end"), coalesceKey: "linter-flow" };
    case "linter-turn-complete":
      // The button-driven (converse debug) lint finished — the auto-off fires.
      return {
        ...norm("internal", "linter", "💡", "linter turn complete"),
        coalesceKey: "linter-flow",
      };
    case "linter-turn-merged":
      return {
        ...norm("internal", "linter", "💡", "linter turn merged"),
        coalesceKey: "linter-flow",
      };
    case "linter-interrupted":
      return {
        ...norm("internal", "linter", "💡", "linter interrupted"),
        coalesceKey: "linter-flow",
      };
    case "linter-go-away":
      return { ...norm("internal", "linter", "💡", "linter go-away"), coalesceKey: "linter-flow" };
    case "linter-transcript-timeout":
      return fail("internal", "⚠", "linter transcript timeout");
    case "linter-error":
      return fail("out", "❌", "linter error");
    case "linter-close":
      return norm("internal", "linter", "💡", "linter close");

    // ── the oracle consumer (converse: auto-VAD + loop) ──────────────────────
    case "oracle-open":
      return norm("internal", "config", "🔮", "oracle open");
    case "oracle-disabled":
      return fail("internal", "⚠", "oracle disabled");
    case "oracle-heard":
      // The model's own record of the human's speech — in lane (it flowed TO it).
      return { ...norm("in", "linter", "🔮", "oracle heard"), coalesceKey: "oracle-flow" };
    case "oracle-said":
      return { ...norm("out", "speech", "🔮", "oracle said"), coalesceKey: "oracle-flow" };
    case "oracle-tool-call":
      return norm("out", "events", "🧩", `oracle tool call ${parsed.tool}`);
    case "oracle-tool-result":
      return norm("in", "events", "🧩", "oracle tool result");
    case "oracle-label":
      return norm("in", "media", "🏷", `${parsed.id} shown to oracle`);
    case "oracle-selection":
      return norm("in", "linter", "⌖", "oracle selection");
    case "oracle-selection-retracted":
      return norm("in", "linter", "⌖", "oracle selection retracted");
    case "oracle-interrupted":
      return {
        ...norm("internal", "linter", "🔮", "oracle interrupted"),
        coalesceKey: "oracle-flow",
      };
    case "oracle-error":
      return fail("out", "❌", "oracle error");
    case "oracle-close":
      return norm("internal", "linter", "🔮", "oracle close");
    case "oracle-addressed":
      // A talk segment routed to the oracle instead of STT (prompt paused).
      return {
        ...norm("internal", "linter", "🔮", `seg addressed to oracle`),
        coalesceKey: "oracle-flow",
      };

    case "video-legacy":
      // A persisted share frame (every frame is saved now); coalesces into one
      // strip card per share, behind the `video` chip.
      return { ...norm("in", "video", "🎞", "video frames"), coalesceKey: "video-in" };

    // ── the retired realtime submode (HISTORICAL traces still render) ─────────
    // A realtime turn's cards ride the same lanes, read one conversation further
    // upstream — the vantage is still the browser, but "the server" is now the
    // live model (Gemini/OpenAI). See archive/transcription-and-realtime-submodes.md.
    case "live-open":
      // Session opened: config-ish, always shown like `intent config`. 🛰 marks
      // it as the *live* session's config.
      return norm("internal", "config", "🛰", "live open");
    case "live-label":
      // A deliberate shot injected into the live session (RT0 finding #5). It
      // flows TO the model → the in lane.
      return norm("in", "media", "🏷", `${parsed.id} shown to model`);
    case "live-nudge":
      return norm("in", "events", "🔔", "live nudge");
    case "live-tool-call":
      return norm("out", "events", "🧩", "live tool call");
    case "live-resolved":
      // The resolved prompt leaves for Claude → agent lane, beside the hero.
      return norm("agent", "lowered", "🚀", "live resolved");
    case "live-reply":
      return norm("out", "speech", "🗣", "live reply");
    case "live-fallback":
      // A degradation (the turn still sends) — errors bucket, ⚠ not ❌.
      return fail("internal", "⚠", "live fallback");

    // ── failures & warnings ──────────────────────────────────────────────────
    case "transcription-failed":
      return fail("out", "❌", "transcription failed"); // pushed to the browser as an error
    case "audio-out-of-order":
      return fail("internal", "⚠", "audio out of order");

    // ── KNOWN DRIFT: living writers with no classifier case, kept on the
    //    generic fallback exactly as before (each is its own visible-behavior
    //    decision, deferred). `realtime discard seg_N` (info → config card),
    //    `linter control` (info → config card), `user text` (ir → compose card).
    case "realtime-discard":
    case "linter-control":
    case "oracle-control":
    case "user-text":
      return genericFallback(stage);

    case "unknown":
      return genericFallback(stage);
    default: {
      // Compile-time exhaustiveness: an unhandled variant makes this fail. At
      // runtime we still degrade to the generic card (never break the view).
      const _exhaustive: never = parsed;
      void _exhaustive;
      return genericFallback(stage);
    }
  }
}

/**
 * Fold a trace's stages into cards: classify each, then collapse consecutive
 * runs that share a non-null `coalesceKey` (per-frame audio, speculative
 * composes) into a single card carrying the whole run's indices and count. The
 * representative stage is the run's *last*, so a coalesced card shows the latest
 * transcript snippet / freshest state, and its raw disclosure can still reach
 * every underlying stage by index.
 */
export function buildCards(stages: TraceStageLike[] | undefined): TraceCard[] {
  const cards: TraceCard[] = [];
  if (!Array.isArray(stages)) {
    return cards;
  }
  stages.forEach((stage, i) => {
    const parsed = parseStageLabel(stage.label ?? "");
    const cls = classifyParsed(parsed, stage);
    const prev = cards[cards.length - 1];
    if (prev && cls.coalesceKey !== null && prev.coalesceKey === cls.coalesceKey) {
      prev.indices.push(i);
      prev.stage = stage;
      prev.parsed = parsed;
      prev.count += 1;
    } else {
      cards.push({ ...cls, parsed, indices: [i], stage, count: 1 });
    }
  });
  return cards;
}

/** Whether a card passes the current direction + bucket filter. */
export function cardVisible(
  card: TraceCard,
  direction: CardDirection | "all",
  enabled: Set<CardCategory>,
): boolean {
  if (direction !== "all" && card.direction !== direction) {
    return false;
  }
  if (ALWAYS_CATEGORIES.includes(card.category)) {
    return true;
  }
  return enabled.has(card.category);
}

// ── the trace's outcome (the status header's headline) ────────────────────────

export type TraceState = "sent" | "cancelled" | "abandoned" | "empty" | "live";

export interface TraceOutcome {
  state: TraceState;
  /** A glyph for the header badge. */
  glyph: string;
  /** A one-word label. */
  label: string;
}

/** The direction-of-outcome at a glance, read off the recorded stages + status. */
export function traceOutcome(trace: { status?: string; stages?: TraceStageLike[] }): TraceOutcome {
  const stages = trace.stages ?? [];
  const hasPrompt = stages.some((s) => parseStageLabel(s.label ?? "").t === "lowered-prompt");
  // A sent prompt is the strongest signal — even a socket that then dropped
  // (status "abandoned") sent its turn, so this wins over the status.
  if (hasPrompt) {
    return { state: "sent", glyph: "✓", label: "sent" };
  }
  const cancelled = stages.some(
    (s) =>
      parseStageLabel(s.label ?? "").t === "conditioned" &&
      (s.data as { cancelled?: unknown })?.cancelled === true,
  );
  if (cancelled) {
    return { state: "cancelled", glyph: "✕", label: "cancelled" };
  }
  if (trace.status === "abandoned") {
    return { state: "abandoned", glyph: "⊘", label: "abandoned" };
  }
  if (trace.status === "completed") {
    // Completed, not cancelled, but nothing sent — an empty turn (all-silent
    // segments, no transcript).
    return { state: "empty", glyph: "∅", label: "no prompt" };
  }
  return { state: "live", glyph: "●", label: "live" };
}

/** The hero's placeholder line for a trace with no lowered prompt to show. */
export function noPromptMessage(state: TraceState): string {
  switch (state) {
    case "cancelled":
      return "no prompt — the turn was cancelled";
    case "abandoned":
      return "no prompt — the turn was abandoned before it sent";
    case "empty":
      return "no prompt — nothing to send (the turn was silent)";
    default:
      return "composing…";
  }
}

// ── the lowered prompt (hero) ─────────────────────────────────────────────────

/** Read a `lowered prompt` output stage's text (string, or `{ text, meta }`). */
export function loweredPromptText(stage: TraceStageLike | undefined): string {
  const data = stage?.data;
  if (typeof data === "string") {
    return data;
  }
  if (data && typeof data === "object" && typeof (data as { text?: unknown }).text === "string") {
    return (data as { text: string }).text;
  }
  return "";
}

/**
 * The freshest **speculative** prompt: what the accumulator had rendered the
 * last time it folded. The channel records `{ transcript, prompt }` on every
 * `recompose()` — i.e. after each interaction that mutates the event log (a
 * committed segment, a wired screenshot, a selection) — so a trace still in
 * flight (or one that was abandoned) already carries the prompt as it stood.
 * The hero falls back to this when no `lowered prompt` stage exists yet, which
 * is what makes the prompt watchable while the turn is still happening rather
 * than only after it commits.
 *
 * Partials never reach the fold, so this text tracks committed segments only —
 * it does not include words currently being spoken.
 */
export function speculativePromptText(stages: TraceStageLike[] | undefined): string {
  if (!Array.isArray(stages)) {
    return "";
  }
  for (let i = stages.length - 1; i >= 0; i--) {
    const stage = stages[i];
    if (parseStageLabel(stage.label ?? "").t !== "composed-speculative") {
      continue;
    }
    // The NEWEST fold wins — including an empty one. Skipping empties (the
    // old rule) resurrected the previous fold after the user retracted the
    // turn's last item: three shots deleted one by one left the hero showing
    // the two-shot prompt forever (seen live 2026-07-13). An empty latest
    // fold means the turn currently HAS no content, and the hero's
    // "no prompt" note is the truthful render of that.
    const prompt = (stage.data as { prompt?: unknown } | undefined)?.prompt;
    return typeof prompt === "string" ? prompt : "";
  }
  return "";
}

// ── streaming transcript partials ────────────────────────────────────────────

/** True for a `stt partial seg_N` stage label. */
export function isPartialLabel(label: string): boolean {
  return parseStageLabel(label).t === "stt-partial";
}

/**
 * The previous partial for the same segment, looking back from `index`. Partials
 * are cumulative, so diffing a partial against this one shows exactly what the
 * vendor revised on that tick — the view in which a shrinking transcript is
 * unmissable. `""` when this is the segment's first partial (everything is an
 * addition, which reads correctly).
 */
export function previousPartialText(stages: TraceStageLike[] | undefined, index: number): string {
  if (!Array.isArray(stages)) {
    return "";
  }
  const label = stages[index]?.label ?? "";
  for (let i = index - 1; i >= 0; i--) {
    if ((stages[i].label ?? "") === label) {
      const text = (stages[i].data as { text?: unknown } | undefined)?.text;
      return typeof text === "string" ? text : "";
    }
  }
  return "";
}

/**
 * The hero's prompt to render: the raw text plus its {@link PromptSpan}
 * annotations, and whether it is the in-flight speculative fold or what was
 * actually sent. The hero renders `text` verbatim and overlays shot
 * hover-previews and a de-emphasized preamble FROM the spans — no regex over
 * the prompt string, no assumption about the shot format. Empty `spans` (an old
 * trace recorded before spans existed, or a bare text-only prompt) just means
 * no overlays: the raw text still renders.
 *
 * Preference: the committed `lowered prompt` (paired with its `lowered prompt
 * spans` companion stage — the sendPrompt tracer records only the text, so the
 * spans ride their own stage) when the turn has sent; otherwise the newest
 * speculative fold, which the accumulator records on every mutation so an
 * in-flight or abandoned turn still shows something.
 */
export interface HeroPrompt {
  text: string;
  spans: PromptSpan[];
  speculative: boolean;
}

/** Defensively read a `{ spans: PromptSpan[] }` stage payload. */
function readSpans(data: unknown): PromptSpan[] {
  const spans = (data as { spans?: unknown } | undefined)?.spans;
  return Array.isArray(spans) ? (spans as PromptSpan[]) : [];
}

/** The sent prompt's spans — the newest `lowered prompt spans` stage. */
function loweredPromptSpans(stages: TraceStageLike[]): PromptSpan[] {
  for (let i = stages.length - 1; i >= 0; i--) {
    if (parseStageLabel(stages[i].label ?? "").t === "lowered-prompt-spans") {
      return readSpans(stages[i].data);
    }
  }
  return [];
}

/** The newest speculative fold's spans — the same stage speculativePromptText reads. */
function speculativeSpans(stages: TraceStageLike[]): PromptSpan[] {
  for (let i = stages.length - 1; i >= 0; i--) {
    if (parseStageLabel(stages[i].label ?? "").t === "composed-speculative") {
      return readSpans(stages[i].data);
    }
  }
  return [];
}

export function heroPrompt(stages: TraceStageLike[] | undefined): HeroPrompt {
  const list = Array.isArray(stages) ? stages : [];
  // Newest-wins, matching the spans lookups below — one pairing policy, so a
  // hypothetical multi-send trace pairs the last prompt with the last spans.
  const sent = loweredPromptText(
    [...list].reverse().find((stage) => parseStageLabel(stage.label ?? "").t === "lowered-prompt"),
  );
  if (sent !== "") {
    return { text: sent, spans: loweredPromptSpans(list), speculative: false };
  }
  const text = speculativePromptText(list);
  return { text, spans: text !== "" ? speculativeSpans(list) : [], speculative: text !== "" };
}

/**
 * The blob file a screenshot path points at. The composed body relativizes shot
 * paths against the agent's cwd, so a hero path may be relative and un-preview-
 * able by the channel's absolute-only `/debug/api/preview` route — but the trace
 * always saved the pixels under a stable basename (`shot_1.png`), which the blob
 * route serves by `(traceId, file)`. Extract that basename so the hero can go
 * straight to the blob regardless of how the path was written.
 */
export function shotBlobName(path: string): string | undefined {
  const base = path.split(/[\\/]/).pop();
  return base && /^shot_\d+\.(png|jpe?g|webp|gif)$/i.test(base) ? base : undefined;
}

// ── V4A patch → diff lines (the correction-patch card) ────────────────────────

export type PatchLineKind = "meta" | "hunk" | "context" | "del" | "add";

export interface PatchLine {
  kind: PatchLineKind;
  /** The line's text, with the diff marker (`-`/`+`/leading space) stripped. */
  text: string;
}

/**
 * Parse a V4A `apply_patch` body into diff lines so a correction patch renders
 * as a *real* red/green diff instead of raw patch text: `-` lines delete, `+`
 * add, ` ` context, `@@`/`*** …` are structural. Mirrors the applier's line
 * grammar (intent-pipeline/patch.ts) closely enough for display.
 */
export function parsePatchLines(patch: string): PatchLine[] {
  return patch.split("\n").map((line): PatchLine => {
    if (line.startsWith("*** ")) {
      return { kind: "meta", text: line };
    }
    if (line.startsWith("@@")) {
      return { kind: "hunk", text: line };
    }
    if (line.startsWith("-")) {
      return { kind: "del", text: line.slice(1) };
    }
    if (line.startsWith("+")) {
      return { kind: "add", text: line.slice(1) };
    }
    if (line.startsWith(" ")) {
      return { kind: "context", text: line.slice(1) };
    }
    return { kind: "context", text: line };
  });
}

// ── event-log summaries (the merged-events card) ──────────────────────────────

/**
 * A compact histogram of an intent event stream — first-seen order, `type ×N`
 * for repeats: `thread-open · talk-start · transcript-final ×3 · shot`. This is
 * how the merged-events card shows *what happened* in a turn at a glance, since
 * the per-frame `events` inputs are opaque blobs and this stage carries the one
 * inlined, authoritative log.
 */
export function eventTypesSummary(events: IntentEvent[]): string {
  const order: string[] = [];
  const counts = new Map<string, number>();
  for (const event of events) {
    const type = event.type;
    if (!counts.has(type)) {
      order.push(type);
    }
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  return order.map((t) => (counts.get(t) === 1 ? t : `${t} ×${counts.get(t)}`)).join(" · ");
}

/** The correction instructions inside an event log, as `“original” → “instruction”`. */
export function correctionLines(events: IntentEvent[]): string[] {
  const lines: string[] = [];
  for (const event of events) {
    if (event.type === "correction") {
      const original = event.original ? `“${event.original}”` : "whole transcript";
      lines.push(`${original} → “${event.instruction}”`);
    }
  }
  return lines;
}

// ── misc formatting ──────────────────────────────────────────────────────────

/** A human span for the header: `840ms`, `6.9s`, `1m 12s`. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    return "";
  }
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const m = Math.floor(seconds / 60);
  const rem = Math.round(seconds % 60);
  return `${m}m ${rem}s`;
}

/** Elapsed time of a trace (start → end, or start → now for a live one). */
export function traceDurationMs(
  trace: { startedAt?: string; endedAt?: string },
  now: number = Date.now(),
): number | undefined {
  if (!trace.startedAt) {
    return undefined;
  }
  const start = Date.parse(trace.startedAt);
  if (Number.isNaN(start)) {
    return undefined;
  }
  const end = trace.endedAt ? Date.parse(trace.endedAt) : now;
  return Number.isNaN(end) ? undefined : end - start;
}

/** Clip a string to `max` chars with an ellipsis (for card one-liners). */
/**
 * Compact USD for rows/cards/headers: sub-cent spends (the pipeline's normal
 * range) keep four significant decimals so "$0.0005" doesn't collapse to "$0.00";
 * anything at a cent or more reads like money.
 */
export function formatUsd(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) {
    return "$0";
  }
  return usd >= 0.01 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(4)}`;
}

/**
 * The one-liner for a 💰 card (and the cost suffix of a correction-patch
 * card): price when known, honest "usage recorded · no price data" when the
 * model is missing from the catalog, and an `~` prefix for estimated usage
 * (TTS reports none, so its figure is a floor).
 */
export function costLine(cost: {
  usd?: number;
  model?: string;
  estimated?: boolean;
  usage?: Record<string, unknown>;
}): string {
  const price =
    cost.usd !== undefined
      ? `${cost.estimated ? "~" : ""}${formatUsd(cost.usd)}`
      : "usage recorded · no price data";
  const usage = cost.usage ?? {};
  const tok = (k: string): number => (typeof usage[k] === "number" ? (usage[k] as number) : 0);
  const parts = [price, cost.model ?? ""].filter(Boolean);
  const inTok = tok("input_tokens");
  const outTok = tok("output_tokens");
  if (inTok || outTok) {
    const audio = tok("input_audio_tokens") + tok("output_audio_tokens");
    parts.push(`${inTok}→${outTok} tok${audio ? ` (${audio} audio)` : ""}`);
  }
  return parts.join(" · ");
}

export function clip(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg)$/i;
const AUDIO_EXT = /\.(webm|mp3|wav|ogg|m4a|opus)$/i;

/** A blob filename that a browser can render as an inline image. */
export function isImageFile(file: string): boolean {
  return IMAGE_EXT.test(file);
}

/** A blob filename a browser can play in an `<audio>` element (`.pcm` cannot). */
export function isPlayableAudioFile(file: string): boolean {
  return AUDIO_EXT.test(file);
}

// ── the realtime submode (live-session cards) ─────────────────────────────────

/**
 * A `live open` stage's one-liner: which vendor/model the live session opened
 * against, and whether it can take video (the 2-minute a+v cap makes this the
 * capability the reader most wants at a glance). Defensive — the descriptor is
 * the channel's `LiveCapabilities`, but a partial payload still reads.
 */
export function liveOpenLine(data: unknown): string {
  const d = (data ?? {}) as { vendor?: unknown; model?: unknown; capabilities?: unknown };
  const vendor = typeof d.vendor === "string" ? d.vendor : "";
  const model = typeof d.model === "string" ? d.model : "";
  const caps = (d.capabilities ?? {}) as { video?: unknown };
  return [vendor, model, `video ${caps.video ? "✓" : "✗"}`].filter(Boolean).join(" · ");
}

/** A piece of a rendered `submit_intent` tool call: a prose run or an image ref. */
export type LiveSegment = { kind: "text"; text: string } | { kind: "image"; marker: string };

/**
 * Parse a `live tool call` stage's verbatim `submit_intent` payload
 * (`{segments:[{text?,image?}...]}` — the shape the live model emits, RT0
 * finding #6) into ordered prose runs and image references, so the tool-call
 * card can render the model's composition the way it was written: cleaned-up
 * text with shot markers positioned in place, not a wall of JSON.
 */
export function liveToolSegments(data: unknown): LiveSegment[] {
  const raw = (data as { segments?: unknown } | undefined)?.segments;
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: LiveSegment[] = [];
  for (const seg of raw) {
    if (!seg || typeof seg !== "object") {
      continue;
    }
    const text = (seg as { text?: unknown }).text;
    const image = (seg as { image?: unknown }).image;
    if (typeof text === "string" && text !== "") {
      out.push({ kind: "text", text });
    } else if (typeof image === "string" && image !== "") {
      out.push({ kind: "image", marker: image });
    }
  }
  return out;
}

/**
 * Summarize a `live resolved` stage: the committed body (a snippet for the
 * card) and how many of the tool call's image markers the channel could
 * resolve to blobs vs. left dangling. Defensive over the payload shape the
 * sibling processor settles on — reads a `refs: [{marker, resolved|path}]`
 * array, or plain `resolved` / `unresolved` marker lists.
 */
export function liveResolvedSummary(data: unknown): {
  body: string;
  resolved: number;
  unresolved: number;
} {
  const d = (data ?? {}) as {
    body?: unknown;
    refs?: unknown;
    resolved?: unknown;
    unresolved?: unknown;
  };
  const body = typeof d.body === "string" ? d.body : "";
  let resolved = 0;
  let unresolved = 0;
  if (Array.isArray(d.refs)) {
    for (const r of d.refs) {
      const ref = (r ?? {}) as { resolved?: unknown; path?: unknown; file?: unknown };
      if (ref.resolved === true || typeof ref.path === "string" || typeof ref.file === "string") {
        resolved += 1;
      } else {
        unresolved += 1;
      }
    }
  } else {
    resolved = Array.isArray(d.resolved) ? d.resolved.length : 0;
    unresolved = Array.isArray(d.unresolved) ? d.unresolved.length : 0;
  }
  return { body, resolved, unresolved };
}

/**
 * The saved keyframe blobs among a coalesced run of video-frame stages. Only
 * ~every 10th frame is persisted (`vid_<id>_<seq>.jpg`), so a `🎞 video stream
 * ×120` card materializes the handful that exist, not the hundreds it covers.
 * Returned in run order; the renderer caps how many thumbnails it draws.
 */
export function savedFrameFiles(stages: TraceStageLike[]): string[] {
  const files: string[] = [];
  for (const s of stages) {
    if (s?.file && isImageFile(s.file)) {
      files.push(s.file);
    }
  }
  return files;
}
