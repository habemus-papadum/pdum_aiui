/**
 * The intent engine: one append-only event stream plus the little state
 * machine around it (armed, mode, talking, thread). UI surfaces (ink canvas,
 * shot tool, audio, preview, inspector) call the verbs; everything they need
 * to render they learn back from the stream. That inversion is deliberate —
 * it forces every interaction to be expressible as events, which is exactly
 * the shape the real protocol will need.
 *
 * Thread lifecycle (the design under test):
 *  - a thread OPENS implicitly on the first contentful act while armed
 *    (talk-start, stroke, or shot) — there is no "begin" gesture;
 *  - it CLOSES explicitly on Enter (send) or Esc (cancel), or — policy,
 *    default off — after `autoEndSec` of idle silence.
 */
import { DEFAULT_INTENT_CONFIG, type IntentPipelineConfig } from "./config";
import { applyCorrectionToLines } from "./patch";
import type { IntentEvent, LocatedComponent, Mode, Rect } from "./types";

export type EngineListener = (event: IntentEvent, engine: Engine) => void;

export interface CorrectionTarget {
  from: number;
  to: number;
  original: string;
}

export class Engine {
  readonly settings: IntentPipelineConfig;
  events: IntentEvent[] = [];
  armed = false;
  mode: Mode = "ink";
  talking = false;
  threadOpen = false;
  /** Set while correct mode has a lassoed range awaiting its instruction. */
  correctionTarget: CorrectionTarget | undefined;

  private listeners: EngineListener[] = [];
  private segmentCounter = 0;
  private shotCounter = 0;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly now: () => number;

  constructor(settings: Partial<IntentPipelineConfig> = {}, now: () => number = () => Date.now()) {
    this.settings = { ...DEFAULT_INTENT_CONFIG, ...settings };
    this.now = now;
  }

  onEvent(listener: EngineListener): void {
    this.listeners.push(listener);
  }

  private emit(event: IntentEvent): void {
    this.events.push(event);
    for (const listener of this.listeners) {
      listener(event, this);
    }
    this.bumpIdleTimer();
  }

  private stamp<T extends Omit<IntentEvent, "at">>(event: T): T & { at: number } {
    return { at: this.now(), ...event } as T & { at: number };
  }

  // ── arming & modes ─────────────────────────────────────────────────────────

  setArmed(on: boolean): void {
    if (on === this.armed) {
      return;
    }
    this.armed = on;
    if (!on) {
      if (this.talking) {
        this.talkEnd();
      }
      if (this.threadOpen) {
        this.closeThread("cancel");
      }
      this.mode = "ink";
      this.correctionTarget = undefined;
    }
    this.emit(this.stamp({ type: "armed", on }));
  }

  setMode(mode: Mode): void {
    if (!this.armed || mode === this.mode) {
      return;
    }
    this.mode = mode;
    if (mode !== "correct") {
      this.correctionTarget = undefined;
    }
    this.emit(this.stamp({ type: "mode", mode }));
  }

  /** Esc, one level at a time: correct → ink → cancel thread → disarm. */
  stepOut(): void {
    if (this.mode === "correct") {
      this.setMode("ink");
      return;
    }
    if (this.threadOpen) {
      this.closeThread("cancel");
      return;
    }
    this.setArmed(false);
  }

  // ── thread ─────────────────────────────────────────────────────────────────

  private ensureThread(trigger: "talk" | "ink" | "shot"): void {
    if (this.threadOpen || !this.armed) {
      return;
    }
    this.threadOpen = true;
    this.emit(this.stamp({ type: "thread-open", trigger }));
  }

  send(): void {
    if (this.threadOpen) {
      if (this.talking) {
        this.talkEnd();
      }
      this.closeThread("send");
    }
  }

  private closeThread(reason: "send" | "cancel" | "timeout"): void {
    this.threadOpen = false;
    this.correctionTarget = undefined;
    this.emit(this.stamp({ type: "thread-close", reason }));
  }

  private bumpIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    if (this.settings.autoEndSec > 0 && this.threadOpen && !this.talking) {
      this.idleTimer = setTimeout(() => {
        if (this.threadOpen && !this.talking) {
          this.closeThread("timeout");
        }
      }, this.settings.autoEndSec * 1000);
    }
  }

  // ── talk ───────────────────────────────────────────────────────────────────

  private talkStartedAt = 0;

  talkStart(): number | undefined {
    if (!this.armed || this.talking) {
      return undefined;
    }
    this.ensureThread("talk");
    this.talking = true;
    this.talkStartedAt = this.now();
    const segment = ++this.segmentCounter;
    this.emit(this.stamp({ type: "talk-start", segment }));
    return segment;
  }

  talkEnd(): void {
    if (!this.talking) {
      return;
    }
    this.talking = false;
    this.emit(
      this.stamp({
        type: "talk-end",
        segment: this.segmentCounter,
        ms: this.now() - this.talkStartedAt,
      }),
    );
  }

  transcriptDelta(segment: number, text: string): void {
    this.emit(this.stamp({ type: "transcript-delta", segment, text }));
  }

  transcriptFinal(segment: number, text: string, latencyMs: number, model: string): void {
    // A segment spoken at a selected correction target *is* the correction.
    const target = this.correctionTarget;
    if (target) {
      this.correctionTarget = undefined;
      this.emit(
        this.stamp({ type: "transcript-final", segment, text, latencyMs, model, correction: true }),
      );
      this.submitCorrection(target, text, "speech");
      return;
    }
    this.emit(this.stamp({ type: "transcript-final", segment, text, latencyMs, model }));
  }

  // ── ink & shots ────────────────────────────────────────────────────────────

  strokeDone(points: number, bounds: Rect): void {
    this.ensureThread("ink");
    this.emit(this.stamp({ type: "stroke", points, bounds }));
  }

  inkCleared(auto: boolean): void {
    this.emit(this.stamp({ type: "ink-clear", auto }));
  }

  shotDone(rect: Rect, components: LocatedComponent[], thumb?: string, path?: string): string {
    this.ensureThread("shot");
    // Identifier-shaped (underscore) so the token can double as a meta key.
    const marker = `shot_${++this.shotCounter}`;
    this.emit(this.stamp({ type: "shot", marker, rect, components, thumb, path }));
    return marker;
  }

  // ── corrections (the meta layer) ───────────────────────────────────────────

  /**
   * The correction micro-pipeline hook (set by main.ts): receives the target
   * + instruction, asks a Corrector for a patch, then calls
   * {@link correction} with the diff. Without a hook (unit tests), the
   * instruction becomes a plain replacement correction directly.
   */
  correctionPipeline?: (
    target: CorrectionTarget,
    instruction: string,
    via: "speech" | "typed",
  ) => void;

  setCorrectionTarget(target: CorrectionTarget | undefined): void {
    this.correctionTarget = target;
  }

  /** Route an instruction for a target into the pipeline (or straight through). */
  submitCorrection(target: CorrectionTarget, instruction: string, via: "speech" | "typed"): void {
    if (this.correctionPipeline) {
      this.correctionPipeline(target, instruction, via);
    } else {
      this.correction(target, instruction, via);
    }
  }

  correction(
    target: CorrectionTarget,
    instruction: string,
    via: "speech" | "typed",
    diff?: { patch: string; model: string; latencyMs: number },
  ): void {
    this.emit(
      this.stamp({
        type: "correction",
        from: target.from,
        to: target.to,
        original: target.original,
        instruction,
        via,
        patch: diff?.patch,
        model: diff?.model,
        latencyMs: diff?.latencyMs,
      }),
    );
  }
}

// ── the first IR pass, pure ──────────────────────────────────────────────────

export interface ComposedItem {
  kind: "text" | "shot";
  text?: string;
  marker?: string;
  thumb?: string;
  path?: string;
  components?: LocatedComponent[];
}

export interface ComposedIntent {
  /** Transcript with `replace`-policy corrections applied. */
  transcript: string;
  /** Chronological interleave of text runs and shot markers. */
  items: ComposedItem[];
  corrections: Array<{ original: string; instruction: string; applied: boolean; patch?: string }>;
  components: LocatedComponent[];
  /**
   * The lowered body, Option-C style (archive/channel-attachment-path-encoding.md):
   * prose with `{shot_n}` tokens at the exact position each image belongs.
   */
  prompt: string;
  /**
   * The lowered meta: `shot_n` → absolute image path, plus `shot_n_info` →
   * the located components. Body token + same-named meta key is what keeps
   * position *and* structure. Shots without a saved file degrade to Option A
   * (inline bracket) and don't appear here.
   */
  meta: Record<string, string>;
}

/**
 * Fold the current thread's events into the composed intent. Pure — the
 * inspector re-runs it on every event, which makes the pass's behavior
 * directly observable while you interact (and trivially unit-testable).
 *
 * Correction semantics under `replace`: each correction rewrites the *first*
 * remaining occurrence of its original text (ranges were lassoed against a
 * live preview; original-text anchoring survives earlier rewrites better
 * than absolute offsets). Under `note`, corrections append as instructions
 * for the downstream lowering model instead.
 */
export function composeIntent(
  events: IntentEvent[],
  policy: "replace" | "note" = "replace",
): ComposedIntent {
  let start = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === "thread-open") {
      start = i;
      break;
    }
  }
  const scope = start === -1 ? events : events.slice(start);

  const items: ComposedItem[] = [];
  const corrections: ComposedIntent["corrections"] = [];
  for (const event of scope) {
    if (event.type === "transcript-final" && !event.correction) {
      // One item per segment, deliberately unmerged: segments-as-lines is the
      // document shape the correction patches (and the corrector model) see.
      items.push({ kind: "text", text: event.text });
    } else if (event.type === "shot") {
      items.push({
        kind: "shot",
        marker: event.marker,
        thumb: event.thumb,
        path: event.path,
        components: event.components,
      });
    } else if (event.type === "correction") {
      corrections.push({
        original: event.original,
        instruction: event.instruction,
        applied: false,
        patch: event.patch,
      });
    }
  }

  if (policy === "replace" && corrections.length) {
    // Corrections are patches against the transcript-as-lines (one text run
    // per line — the same document shape the corrector model saw).
    const textIndexes = items
      .map((item, index) => (item.kind === "text" ? index : -1))
      .filter((index) => index !== -1);
    let lines = textIndexes.map((index) => items[index].text ?? "");
    for (const correction of corrections) {
      const result = applyCorrectionToLines(lines, correction);
      lines = result.lines;
      correction.applied = result.applied;
    }
    // Map lines back onto the interleave: 1:1 while both last, extra lines
    // append as a trailing run, vanished lines drop their runs.
    for (let k = 0; k < Math.min(lines.length, textIndexes.length); k++) {
      items[textIndexes[k]].text = lines[k];
    }
    if (lines.length > textIndexes.length) {
      items.push({ kind: "text", text: lines.slice(textIndexes.length).join(" ") });
    } else if (lines.length < textIndexes.length) {
      const dropped = new Set(textIndexes.slice(lines.length));
      for (let index = items.length - 1; index >= 0; index--) {
        if (dropped.has(index)) {
          items.splice(index, 1);
        }
      }
    }
  }

  const components = items.flatMap((item) => item.components ?? []);
  const transcript = items
    .filter((item) => item.kind === "text")
    .map((item) => item.text)
    .join(" ")
    .trim();

  const promptParts: string[] = [];
  const meta: Record<string, string> = {};
  for (const item of items) {
    if (item.kind === "text" && item.text) {
      promptParts.push(item.text);
    } else if (item.kind === "shot" && item.marker) {
      const info = item.components?.length
        ? item.components.map((c) => `${c.component} @ ${c.source}`).join(", ")
        : "";
      if (item.path) {
        // Option C: positional token in the body, path in same-named meta.
        promptParts.push(`{${item.marker}}`);
        meta[item.marker] = item.path;
        if (info) {
          meta[`${item.marker}_info`] = info;
        }
      } else {
        // No file on disk — degrade to an inline bracket (Option A-ish).
        promptParts.push(`[${item.marker}${info ? ` (components: ${info})` : ""}]`);
      }
    }
  }
  if (policy === "note") {
    for (const correction of corrections) {
      promptParts.push(`(transcription fix: "${correction.original}" → ${correction.instruction})`);
    }
  }
  if (Object.keys(meta).some((k) => !k.endsWith("_info"))) {
    // The doc's one-line hint: make the token→meta convention explicit.
    promptParts.push("({shot_n} tokens are attached image paths — open them to look.)");
  }

  return { transcript, items, corrections, components, prompt: promptParts.join(" ").trim(), meta };
}
