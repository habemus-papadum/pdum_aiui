/**
 * params.ts — the tunable surface as DATA: one row per parameter, for the
 * Realtime session object and for the WebRTC mic track. The widgets render
 * from these tables and nothing else, so adding a knob is a row rather than a
 * component.
 *
 * Two rules hold this together.
 *
 * **Vendor names, verbatim** (owner, 2026-07-30). A row's `name` IS its label:
 * `silence_duration_ms`, `eagerness`, `echoCancellation`. Nothing here is
 * re-spelled, prettified, or title-cased. That means the two namespaces stay
 * visibly unharmonized — snake_case from OpenAI's JSON sitting next to
 * camelCase from the WebRTC constraint dictionary — and that inconsistency is
 * load-bearing: the casing tells you which manual the word came from. Do not
 * "fix" it.
 *
 * **Nothing here predicts what the platform will accept.** `when` records what
 * the vendor documents as changeable, and the browser's own
 * `getSupportedConstraints()` decides the WebRTC half; but the authority on
 * whether a change TOOK is always the readback — `session.updated` for the
 * session, `track.getSettings()` for the mic. The tables say what is worth
 * trying and the echo says what happened. That split is why this can expose
 * parameters whose behaviour we are unsure of without lying about any of them.
 */

import type { OracleConfig } from "./types";

/** When a parameter may be changed — the basis for disabling a control. */
export type ParamWhen =
  /** Any time a session is open. */
  | "live"
  /** Baked at connect; changing it needs a reconnect. */
  | "connect"
  /** Editable until the model has spoken, frozen after (the vendor's rule
   * for `voice` — not connect-time, which is why it is its own case). */
  | "before-first-reply";

export interface ParamSpec {
  /** The vendor's own name. Also the label — see the module note. */
  name: string;
  /** The enclosing object's vendor name — the heading rows sit under, so a
   * row can be labelled `type` without ambiguity about WHICH type. */
  group: string;
  /**
   * The platform's default, as text, for display beside the control.
   *
   * Here rather than in prose because "what is the default" is the first
   * question anyone tuning this asks, and an answer that lives in a chat log
   * or a doc goes stale silently. Shown as the input's placeholder, so an
   * UNSET control reads as the value it will actually behave as.
   */
  default?: string;
  /**
   * Which surface the row belongs to. `"session"` (the default) is the
   * vendor's own object; `"aiui"` is a knob WE implement, which has no wire
   * representation at all.
   *
   * The distinction is load-bearing given the verbatim-names rule: an aiui row
   * cannot claim vendor provenance, so it is marked, grouped separately, and
   * labelled as ours. Mixing the two silently would make the whole table's
   * naming claim untrustworthy.
   */
  scope?: "session" | "aiui";
  /** Dotted path, rooted at the session object, the constraints object, or —
   * for `scope: "aiui"` — the config's own behaviour fields. */
  path: string;
  kind: "boolean" | "number" | "range" | "enum" | "text";
  /** For `kind: "enum"`. Values are the vendor's literals; `null` where the
   * vendor's own spelling for "off" is null. */
  options?: readonly (string | null)[];
  min?: number;
  max?: number;
  step?: number;
  when: ParamWhen;
  /** One line of vendor semantics — what it does, and the default. */
  hint: string;
  /** Show this row only when another row holds a given value (the
   * server_vad / semantic_vad split). */
  requires?: { path: string; equals: unknown };
}

export const TURN_DETECTION = "audio.input.turn_detection";
export const TURN_DETECTION_TYPE = `${TURN_DETECTION}.type`;

const isServerVad = { path: TURN_DETECTION_TYPE, equals: "server_vad" } as const;
const isSemanticVad = { path: TURN_DETECTION_TYPE, equals: "semantic_vad" } as const;

/**
 * The Realtime session parameters. Ordered as you would tune them: how a turn
 * ends first (the thing that actually bites), then what the mic feeds the
 * model, then the reply.
 */
export const SESSION_PARAMS: readonly ParamSpec[] = [
  {
    name: "type",
    group: "turn_detection",
    default: "server_vad",
    path: TURN_DETECTION_TYPE,
    kind: "enum",
    options: ["server_vad", "semantic_vad", null],
    when: "live",
    hint: "server_vad ends a turn on silence; semantic_vad classifies whether you FINISHED; null is manual.",
  },
  {
    name: "threshold",
    group: "turn_detection",
    default: "0.5",
    path: `${TURN_DETECTION}.threshold`,
    kind: "number",
    min: 0,
    max: 1,
    step: 0.05,
    when: "live",
    hint: "Activation energy, 0–1. Default 0.5. Higher ignores quieter sound, including a reply leaking back in.",
    requires: isServerVad,
  },
  {
    name: "silence_duration_ms",
    group: "turn_detection",
    default: "500",
    path: `${TURN_DETECTION}.silence_duration_ms`,
    kind: "number",
    min: 0,
    max: 10_000,
    step: 100,
    when: "live",
    hint: "Silence that ends a turn. Default 500 — the field a pause-to-think runs into.",
    requires: isServerVad,
  },
  {
    name: "prefix_padding_ms",
    group: "turn_detection",
    default: "300",
    path: `${TURN_DETECTION}.prefix_padding_ms`,
    kind: "number",
    min: 0,
    max: 2_000,
    step: 50,
    when: "live",
    hint: "Audio kept from BEFORE the detected start. Default 300.",
    requires: isServerVad,
  },
  {
    name: "idle_timeout_ms",
    group: "turn_detection",
    default: "null (off)",
    path: `${TURN_DETECTION}.idle_timeout_ms`,
    kind: "number",
    min: 0,
    max: 120_000,
    step: 1_000,
    when: "live",
    hint: "Idle time before the model speaks unprompted. Unset disables.",
    requires: isServerVad,
  },
  {
    name: "eagerness",
    group: "turn_detection",
    default: "auto (= medium, 4s)",
    path: `${TURN_DETECTION}.eagerness`,
    kind: "enum",
    options: ["low", "medium", "high", "auto"],
    when: "live",
    hint: "How long it waits before taking the turn: low 8s, medium/auto 4s, high 2s. auto = medium.",
    requires: isSemanticVad,
  },
  {
    name: "create_response",
    group: "turn_detection",
    default: "true",
    path: `${TURN_DETECTION}.create_response`,
    kind: "boolean",
    when: "live",
    hint: "Whether a detected end-of-turn generates a reply. Default true. Off + interrupt_response off = never responds.",
  },
  {
    name: "interrupt_response",
    group: "turn_detection",
    default: "true",
    path: `${TURN_DETECTION}.interrupt_response`,
    kind: "boolean",
    when: "live",
    hint: "Whether detected speech interrupts a reply in progress. Default true. firstReplyGuard forces this off until the first reply finishes.",
  },
  {
    name: "type",
    group: "noise_reduction",
    default: "null (off)",
    path: "audio.input.noise_reduction.type",
    kind: "enum",
    options: ["near_field", "far_field", null],
    when: "live",
    hint: "near_field is a headset; far_field a mic across the room from its own speakers.",
  },
  {
    name: "model",
    group: "transcription",
    default: "null (no transcription)",
    path: "audio.input.transcription.model",
    kind: "text",
    when: "live",
    hint: "Transcribes YOUR audio — what makes the `heard` record. Costs transcription tokens.",
  },
  {
    name: "language",
    group: "transcription",
    default: "auto-detect",
    path: "audio.input.transcription.language",
    kind: "text",
    when: "live",
    hint: "ISO-639-1 (e.g. en). Improves accuracy and latency when known.",
  },
  {
    name: "speed",
    group: "audio.output",
    default: "1.0",
    path: "audio.output.speed",
    kind: "number",
    min: 0.25,
    max: 1.5,
    step: 0.05,
    when: "live",
    hint: "Reply playback rate. Default 1.0.",
  },
  {
    name: "voice",
    group: "audio.output",
    default: "marin (ours)",
    path: "audio.output.voice",
    kind: "text",
    when: "before-first-reply",
    hint: "FROZEN once the model has spoken — a session.update may not change it after.",
  },
  {
    name: "max_output_tokens",
    group: "session",
    default: "inf",
    path: "max_output_tokens",
    kind: "number",
    min: 1,
    max: 32_000,
    step: 100,
    when: "live",
    hint: "Cap on one response. Unset means the model's own limit.",
  },
  {
    name: "model",
    group: "session",
    default: "gpt-realtime-2.1 (ours)",
    path: "model",
    kind: "text",
    when: "connect",
    hint: "FROZEN at connect. Changing it needs a new session.",
  },
  {
    name: "parkAfterIdleSeconds",
    group: "aiui — ours, not the vendor's",
    scope: "aiui",
    default: "120",
    path: "parkAfterIdleSeconds",
    kind: "range",
    min: 0,
    max: 300,
    step: 5,
    when: "live",
    hint: "Park the session after this long with no activity. 0 disables. Not the vendor's idle_timeout_ms — this one STOPS listening, that one starts talking.",
  },
];

/**
 * The WebRTC mic constraints. `MediaTrackConstraints` names, camelCase, from
 * the WebRTC spec rather than OpenAI's docs — see the module note on why the
 * two tables deliberately do not match in style.
 *
 * `when: "live"` here is a claim about the SPEC, not about the browser: which
 * of these `applyConstraints()` will honour on an already-open track varies by
 * platform and device, and the readback is what settles it. The three
 * processing booleans are the ones that matter for an agent that talks back
 * through the same device it listens on (see `ECHO_SAFE_AUDIO`).
 */
export const CONSTRAINT_PARAMS: readonly ParamSpec[] = [
  {
    name: "echoCancellation",
    group: "processing",
    default: "true (we ASK for it — ECHO_SAFE_AUDIO)",
    path: "echoCancellation",
    kind: "boolean",
    when: "live",
    hint: "Cancels the reply leaking back through the mic. Adaptive — it has no model of the room until it has heard far-end audio.",
  },
  {
    name: "noiseSuppression",
    group: "processing",
    default: "true (we ASK for it — ECHO_SAFE_AUDIO)",
    path: "noiseSuppression",
    kind: "boolean",
    when: "live",
    hint: "Suppresses steady background noise.",
  },
  {
    name: "autoGainControl",
    group: "processing",
    default: "true (we ASK for it — ECHO_SAFE_AUDIO)",
    path: "autoGainControl",
    kind: "boolean",
    when: "live",
    hint: "Normalizes input level. Can raise residual echo along with your voice.",
  },
  {
    name: "channelCount",
    group: "capture",
    default: "the device's own",
    path: "channelCount",
    kind: "number",
    min: 1,
    max: 2,
    step: 1,
    when: "connect",
    hint: "Mono or stereo capture. Reacquiring the device is what actually changes it.",
  },
  {
    name: "sampleRate",
    group: "capture",
    default: "the device's own",
    path: "sampleRate",
    kind: "number",
    min: 8_000,
    max: 48_000,
    step: 1_000,
    when: "connect",
    hint: "Capture rate in Hz. Set by the device; rarely honoured as a live change.",
  },
  {
    name: "sampleSize",
    group: "capture",
    default: "the device's own",
    path: "sampleSize",
    kind: "number",
    min: 8,
    max: 32,
    step: 8,
    when: "connect",
    hint: "Bits per sample.",
  },
  {
    name: "latency",
    group: "capture",
    default: "the device's own",
    path: "latency",
    kind: "number",
    min: 0,
    max: 1,
    step: 0.01,
    when: "connect",
    hint: "Target capture latency in seconds.",
  },
  {
    name: "deviceId",
    group: "capture",
    default: "default",
    path: "deviceId",
    kind: "text",
    when: "connect",
    hint: "Which microphone. Switching devices means reopening the track.",
  },
];

// ── path access (the tables address values by dotted path) ───────────────────

export function getPath(root: unknown, path: string): unknown {
  let node: unknown = root;
  for (const key of path.split(".")) {
    if (node === null || typeof node !== "object") {
      return undefined;
    }
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

/**
 * Write a dotted path, creating objects on the way down.
 *
 * `undefined` DELETES the key rather than storing it: the vendor's default and
 * an explicit value are different states, and a session object carrying
 * `threshold: undefined` would serialize the key away anyway — so deleting is
 * the honest representation of "unset". `null` is left alone, because for
 * `turn_detection` and `noise_reduction` null is a meaningful value.
 */
export function setPath(root: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split(".");
  const last = keys.pop();
  if (last === undefined) {
    return;
  }
  let node = root;
  for (const key of keys) {
    const next = node[key];
    if (next === null || typeof next !== "object") {
      node[key] = {};
    }
    node = node[key] as Record<string, unknown>;
  }
  if (value === undefined) {
    delete node[last];
  } else {
    node[last] = value;
  }
}

/**
 * Drop the knobs that belong to the OTHER turn-detection algorithm.
 *
 * `threshold` means nothing to `semantic_vad` and `eagerness` nothing to
 * `server_vad`, so carrying them across a type switch would send fields the
 * vendor must reject or ignore — and the drift check would then report a
 * problem we created ourselves. Setting the type to `null` collapses the whole
 * object, which is the vendor's own spelling for no turn detection.
 */
export function pruneTurnDetection(config: OracleConfig): void {
  const input = config.audio?.input;
  if (input === undefined) {
    return;
  }
  const detection = input.turn_detection;
  if (detection === null || detection === undefined) {
    // Both already collapsed — and they are DIFFERENT states (null is the
    // vendor's manual mode, undefined is "take your default"), so neither may
    // be normalized into the other on the way past.
    return;
  }
  const kept: Record<string, unknown> = {};
  const held = detection as unknown as Record<string, unknown>;
  const shared = ["type", "create_response", "interrupt_response"];
  const own =
    detection.type === "semantic_vad"
      ? ["eagerness"]
      : ["threshold", "prefix_padding_ms", "silence_duration_ms", "idle_timeout_ms"];
  for (const key of [...shared, ...own]) {
    const value = held[key];
    if (value !== undefined) {
      kept[key] = value;
    }
  }
  input.turn_detection = kept as unknown as NonNullable<typeof detection>;
}

/**
 * Whether what we asked for and what is in force disagree in a way worth
 * flagging.
 *
 * An UNSET row is never drift: not sending a field means "your default", so
 * the platform holding one is agreement, not conflict. Only a value we
 * actually asked for and did not get counts — otherwise every untouched row
 * would light up the moment a server echoed its own defaults back, and the
 * signal that matters would be lost in it.
 */
export function rowDrifts(value: unknown, effective: unknown): boolean {
  if (value === undefined || effective === undefined) {
    return false;
  }
  return JSON.stringify(value) !== JSON.stringify(effective);
}

/** Runs of rows sharing a `group`, in table order — the widgets' sections.
 * Order is the table's, not alphabetical: the tables are already ordered as
 * you would tune them, and re-sorting would discard that. */
export function groupSpecs(
  specs: readonly ParamSpec[],
): Array<{ name: string; specs: ParamSpec[] }> {
  const groups: Array<{ name: string; specs: ParamSpec[] }> = [];
  for (const spec of specs) {
    const last = groups.at(-1);
    if (last !== undefined && last.name === spec.group) {
      last.specs.push(spec);
    } else {
      groups.push({ name: spec.group, specs: [spec] });
    }
  }
  return groups;
}

/** Whether a row applies, given the config it is rendering. */
export function specApplies(spec: ParamSpec, config: unknown): boolean {
  if (spec.requires === undefined) {
    return true;
  }
  const held = getPath(config, spec.requires.path);
  // An absent turn_detection.type means the engine's default, server_vad —
  // the row must not vanish just because nobody has set it explicitly yet.
  const effective = held ?? (spec.requires.path === TURN_DETECTION_TYPE ? "server_vad" : undefined);
  return effective === spec.requires.equals;
}
