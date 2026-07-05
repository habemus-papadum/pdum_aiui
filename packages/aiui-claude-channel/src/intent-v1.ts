/**
 * The `intent-v1` stream format: the multimodal intent tool's wire format and
 * its lowering processor.
 *
 * Where `text-concat` accumulates a string, `intent-v1` accumulates the intent
 * tool's **event log** plus binary attachments, and on `fin` lowers the whole
 * turn into one Option-C prompt (body with `{shot_N}` tokens, paths in meta).
 * The pipeline core — `composeIntent`, the V4A applier, the config shape — is
 * imported from `@habemus-papadum/aiui-dev-overlay/intent-pipeline`, the same
 * module the browser modality runs, so one implementation and one set of
 * captured fixtures cover both sides (see the graduation handoff, P2).
 *
 * Frames are tagged in the envelope ({@link ChunkDescriptor}); the codec is the
 * identity codec ({@link rawCodec}) because a payload's meaning depends on its
 * chunk kind, which the codec — seeing only bytes — cannot know. The processor
 * interprets each payload from `meta.chunk`:
 *
 *  - `events`   → JSON `{ events }`: appended to the turn's stream in order.
 *  - `attachment shot_N` → a PNG: conditioned (downscale slot), saved to the
 *    trace blob store on fin, its path wired into the Option-C meta.
 *  - `attachment seg_N`  → audio: conditioned (silence-trim slot) and, when the
 *    hello asked for server-side transcription, transcribed here — the produced
 *    `transcript-final` event is both merged into the stream and pushed back to
 *    the client as a `lowered` message.
 *  - `context`  → JSON `{ selection }`: the on-screen selection, at most once.
 *
 * A correction event that arrives without a `patch` while the hello selected
 * the OpenAI corrector is a request: the V4A diff runs here (against the current
 * composed transcript) and the completed correction is merged and pushed back.
 * A thread that ends in `cancel` (or never fins) lowers to nothing.
 */
import {
  applyPatch,
  composeIntent,
  DEFAULT_INTENT_CONFIG,
  type IntentEvent,
} from "@habemus-papadum/aiui-dev-overlay/intent-pipeline";
import type { ChannelFormat, MessageMeta, ThreadContext } from "./channel";
import { rawCodec } from "./codec";
import { type Corrector, openaiCorrector } from "./correct";
import type { ChunkDescriptor } from "./frame";
import { asSelection, augmentTextPrompt, type SelectionContext } from "./prompt-context";
import { traceOf } from "./tracing";
import {
  audioExtensionForMime,
  type FetchLike,
  openaiTranscriber,
  type Transcriber,
} from "./transcribe";

/**
 * A server-produced batch of intent events, pushed to the client to merge into
 * its own stream (transcripts it did not compute, completed correction diffs).
 * Distinguished from a per-frame ack by its `kind` field.
 */
export interface LoweredMessage {
  kind: "lowered";
  threadId: string;
  events: IntentEvent[];
}

/** The subset of `IntentPipelineConfig` the lowering reads off the hello. */
interface ResolvedIntent {
  transcriber: "mock" | "openai";
  model: string;
  corrector: "mock" | "openai";
  correctionModel: string;
  correctionPolicy: "replace" | "note";
  passes: { silenceTrim: boolean; imageDownscale: boolean };
}

/** Dependency injection + env for the format (real seams in prod, mocks in tests). */
export interface IntentV1Options {
  /** OpenAI key; defaults to `process.env.OPENAI_API_KEY`. */
  apiKey?: string;
  /** Injected fetch for the real seams (defaults to the global). */
  fetch?: FetchLike;
  /**
   * Test seam override — used whenever the hello selects `transcriber: openai`,
   * in place of the real REST transcriber.
   */
  transcriber?: Transcriber;
  /** Test seam override — used whenever the hello selects `corrector: openai`. */
  corrector?: Corrector;
}

/** Read the fields the lowering uses off the loosely-typed hello `intent`, with defaults. */
function resolveIntent(raw: unknown): ResolvedIntent {
  const cfg = (raw !== null && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
    typeof value === "string" && (allowed as readonly string[]).includes(value)
      ? (value as T)
      : fallback;
  const str = (value: unknown, fallback: string): string =>
    typeof value === "string" && value !== "" ? value : fallback;
  const passes = (
    cfg.passes !== null && typeof cfg.passes === "object" ? cfg.passes : {}
  ) as Record<string, unknown>;
  return {
    transcriber: oneOf(
      cfg.transcriber,
      ["mock", "openai"] as const,
      DEFAULT_INTENT_CONFIG.transcriber,
    ),
    model: str(cfg.model, DEFAULT_INTENT_CONFIG.model),
    corrector: oneOf(cfg.corrector, ["mock", "openai"] as const, DEFAULT_INTENT_CONFIG.corrector),
    correctionModel: str(cfg.correctionModel, DEFAULT_INTENT_CONFIG.correctionModel),
    correctionPolicy: oneOf(
      cfg.correctionPolicy,
      ["replace", "note"] as const,
      DEFAULT_INTENT_CONFIG.correctionPolicy,
    ),
    passes: {
      silenceTrim: passes.silenceTrim === true,
      imageDownscale: passes.imageDownscale === true,
    },
  };
}

// ── the cleanup passes (openai-audio-stack.md) ───────────────────────────────
// Condition passes shrink/clean an upload *before* the expensive hop. Real
// trimming/downscaling is a lab measurement that ships later; the structure —
// a named slot on each side of the pipe, gated by config — is what P2 commits
// to, so the pipeline is already shaped for the real behavior. Identity today.

interface PassResult {
  bytes: Uint8Array;
  /** Whether the slot was engaged (config on) — recorded in the trace. */
  engaged: boolean;
}

const silenceTrim = (bytes: Uint8Array, enabled: boolean): PassResult => ({
  bytes,
  engaged: enabled,
});
const imageDownscale = (bytes: Uint8Array, enabled: boolean): PassResult => ({
  bytes,
  engaged: enabled,
});

/** Parse the trailing ordinal of an identifier-shaped attachment id (`seg_3` → 3). */
function ordinalOf(id: string): number {
  const match = /_(\d+)$/.exec(id);
  return match ? Number(match[1]) : 0;
}

/** True when the current thread (from its last open) ended in an explicit cancel. */
function endedInCancel(events: IntentEvent[]): boolean {
  let start = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === "thread-open") {
      start = i;
      break;
    }
  }
  const scope = start === -1 ? events : events.slice(start);
  for (let i = scope.length - 1; i >= 0; i--) {
    const event = scope[i];
    if (event.type === "thread-close") {
      return event.reason === "cancel";
    }
  }
  return false;
}

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

/** Decode a JSON chunk payload (events / context frames). */
function decodeJson(bytes: Uint8Array): unknown {
  if (bytes.length === 0) {
    return undefined;
  }
  return JSON.parse(utf8Decoder.decode(bytes));
}

/** Narrow a decoded events chunk to `IntentEvent[]` (append-only batch). */
function readEventBatch(decoded: unknown): IntentEvent[] {
  if (decoded === null || typeof decoded !== "object") {
    throw new Error('intent-v1 events chunk must be JSON { "events": IntentEvent[] }');
  }
  const { events } = decoded as { events?: unknown };
  if (!Array.isArray(events)) {
    throw new Error('intent-v1 events chunk is missing an "events" array');
  }
  return events as IntentEvent[];
}

/**
 * Build the `intent-v1` format. The zero-arg {@link intentV1Format} registers
 * the real (env-keyed, network) seams; tests build their own with mock seams.
 */
export function createIntentV1Format(options: IntentV1Options = {}): ChannelFormat {
  return {
    codec: rawCodec,
    createProcessor: (ctx: ThreadContext) => intentProcessor(ctx, options),
  };
}

function intentProcessor(ctx: ThreadContext, options: IntentV1Options) {
  const intent = resolveIntent(ctx.hello?.intent);
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
  const trace = traceOf(ctx);

  // Resolve the pipe seams once. `openai` requested but keyless (and no test
  // override) → the seam is absent and that stage degrades (no transcript /
  // plain-replacement correction) rather than failing the turn.
  const transcriber: Transcriber | undefined =
    intent.transcriber === "openai"
      ? (options.transcriber ??
        (apiKey
          ? openaiTranscriber({ model: () => intent.model, apiKey, fetch: options.fetch })
          : undefined))
      : undefined;
  const corrector: Corrector | undefined =
    intent.corrector === "openai"
      ? (options.corrector ??
        (apiKey
          ? openaiCorrector({ model: () => intent.correctionModel, apiKey, fetch: options.fetch })
          : undefined))
      : undefined;

  trace?.record({
    kind: "info",
    label: "intent config",
    data: {
      transcriber: intent.transcriber,
      model: intent.model,
      corrector: intent.corrector,
      correctionModel: intent.correctionModel,
      correctionPolicy: intent.correctionPolicy,
      passes: intent.passes,
      transcriberReady: transcriber !== undefined,
      correctorReady: corrector !== undefined,
    },
  });

  // The turn's single accumulated stream, in arrival order — client events
  // interleaved with server-produced ones (transcripts, completed corrections)
  // exactly where they were produced. This *is* the merge the fin lowering runs.
  let events: IntentEvent[] = [];
  const attachments = new Map<string, { mime: string; bytes: Uint8Array }>();
  let selection: SelectionContext | undefined;
  let engagedSilenceTrim = false;
  let engagedImageDownscale = false;

  const push = (produced: IntentEvent[]): void => {
    ctx.push?.({
      kind: "lowered",
      threadId: ctx.threadId,
      events: produced,
    } satisfies LoweredMessage);
  };

  /** Run the correction diff for a patchless request, or fall back on failure. */
  const resolveCorrection = async (
    request: Extract<IntentEvent, { type: "correction" }>,
  ): Promise<void> => {
    // Document = segments-as-lines from the current composed state (the same
    // shape the corrector model and the applier share — field-notes contract).
    const composed = composeIntent(events, intent.correctionPolicy);
    const docLines = composed.items
      .filter((item) => item.kind === "text")
      .map((item) => item.text ?? "");
    try {
      const diff = await corrector?.diff({
        docLines,
        selected: request.original,
        instruction: request.instruction,
      });
      if (!diff) {
        throw new Error("corrector unavailable");
      }
      // Validate the patch actually applies; a patch that does not is treated
      // as malformed and dropped so the client falls back to plain replacement.
      applyPatch(docLines, diff.patch);
      const completed: IntentEvent = {
        ...request,
        patch: diff.patch,
        model: diff.model,
        latencyMs: diff.latencyMs,
      };
      events.push(completed);
      push([completed]);
    } catch {
      // Corrections never silently vanish: push the request through without a
      // patch (plain first-occurrence replacement downstream).
      const fallback: IntentEvent = { ...request, patch: undefined };
      events.push(fallback);
      push([fallback]);
    }
  };

  const onEventsChunk = async (bytes: Uint8Array): Promise<void> => {
    for (const event of readEventBatch(decodeJson(bytes))) {
      // A patchless correction under the OpenAI corrector is a diff request; the
      // completed correction is pushed into this same stream (and echoed). Every
      // other event — including a correction that already carries its patch — is
      // appended in arrival order. The client applies our echo locally and never
      // re-sends the correction, so no patched twin appears on the wire.
      if (event.type === "correction" && event.patch === undefined && corrector !== undefined) {
        await resolveCorrection(event);
      } else {
        events.push(event);
      }
    }
  };

  const onAttachmentChunk = async (
    chunk: Extract<ChunkDescriptor, { kind: "attachment" }>,
    bytes: Uint8Array,
  ): Promise<void> => {
    const { id, mime } = chunk;
    if (id.startsWith("seg_")) {
      const conditioned = silenceTrim(bytes, intent.passes.silenceTrim);
      engagedSilenceTrim = engagedSilenceTrim || conditioned.engaged;
      attachments.set(id, { mime, bytes });
      if (transcriber !== undefined) {
        const result = await transcriber.transcribe({ bytes: conditioned.bytes, mime });
        const produced: IntentEvent = {
          at: Date.now(),
          type: "transcript-final",
          segment: ordinalOf(id),
          text: result.text,
          latencyMs: result.latencyMs,
          model: result.model,
        };
        events.push(produced);
        push([produced]);
      }
    } else if (id.startsWith("shot_")) {
      const conditioned = imageDownscale(bytes, intent.passes.imageDownscale);
      engagedImageDownscale = engagedImageDownscale || conditioned.engaged;
      attachments.set(id, { mime, bytes: conditioned.bytes });
    } else {
      attachments.set(id, { mime, bytes });
    }
  };

  const onContextChunk = (bytes: Uint8Array): void => {
    const decoded = decodeJson(bytes);
    selection = asSelection(decoded) ?? selection;
  };

  /** The fin lowering: assemble the Option-C prompt and notify the session. */
  const lower = async (): Promise<void> => {
    // Save attachment blobs to the trace store; a shot's saved path becomes its
    // Option-C meta value (audio segments are saved for the debugger only).
    const shotPaths = new Map<string, string>();
    for (const [id, { mime, bytes }] of attachments) {
      if (id.startsWith("shot_")) {
        const path = trace?.recordBlob(
          { kind: "ir", label: `attachment ${id}` },
          bytes,
          `${id}.png`,
        );
        if (path !== undefined) {
          shotPaths.set(id, path);
        }
      } else if (id.startsWith("seg_")) {
        trace?.recordBlob(
          { kind: "ir", label: `attachment ${id}` },
          bytes,
          `${id}.${audioExtensionForMime(mime)}`,
        );
      }
    }
    if (shotPaths.size > 0) {
      events = events.map((event) =>
        event.type === "shot" && shotPaths.has(event.marker)
          ? { ...event, path: shotPaths.get(event.marker) }
          : event,
      );
    }

    trace?.record({ kind: "ir", label: "merged events", data: events });

    const cancelled = endedInCancel(events);
    const composed = composeIntent(events, intent.correctionPolicy);
    trace?.record({
      kind: "ir",
      label: "composed intent",
      data: {
        transcript: composed.transcript,
        items: composed.items,
        corrections: composed.corrections,
        prompt: composed.prompt,
        meta: composed.meta,
      },
    });
    trace?.record({
      kind: "ir",
      label: "conditioned",
      data: {
        cancelled,
        passes: {
          silenceTrim: { enabled: intent.passes.silenceTrim, engaged: engagedSilenceTrim },
          imageDownscale: { enabled: intent.passes.imageDownscale, engaged: engagedImageDownscale },
        },
        body: composed.prompt,
        meta: composed.meta,
      },
    });

    // A cancelled turn (or one with nothing to say) lowers to no notification.
    if (!cancelled && composed.prompt !== "") {
      const prompt = augmentTextPrompt(composed.prompt, ctx.hello, selection);
      const meta = Object.keys(composed.meta).length > 0 ? composed.meta : undefined;
      await ctx.sendPrompt(prompt, meta);
    }
    ctx.close();
  };

  return {
    async onMessage(payload: unknown, meta: MessageMeta) {
      const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(0);
      const chunk = meta.chunk;
      if (chunk?.kind === "events") {
        await onEventsChunk(bytes);
      } else if (chunk?.kind === "attachment") {
        await onAttachmentChunk(chunk, bytes);
      } else if (chunk?.kind === "context") {
        onContextChunk(bytes);
      }
      if (meta.fin) {
        await lower();
      }
    },
  };
}

/** The built-in `intent-v1` format (real env-keyed seams). */
export const intentV1Format: ChannelFormat = createIntentV1Format();
