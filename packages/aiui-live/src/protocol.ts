/**
 * protocol.ts — the GPT-Live wire vocabulary, typed. Ground truth is the
 * vendor's live guides (live, live-conversations, live-delegation), read as
 * exact markdown on 2026-09-15 and measured against the real API by
 * `exploration/live-probe`. Where this file disagrees with a guide, the guide
 * is newer — fix this file.
 *
 * Two facts shape everything downstream:
 *  - the session is nearly IMMUTABLE after start (model, instructions, input,
 *    audio, store, delegation.type are frozen); the only live levers are the
 *    three append events and a `session.update` of the Responses delegation;
 *  - the voice model never calls a tool itself. Work leaves it as a
 *    DELEGATION (a ticket with an id) and comes back as appends on that id.
 */

export const LIVE_MODEL = "gpt-live-1";
export const LIVE_BASE_URL = "https://api.openai.com";
export const LIVE_SESSIONS_PATH = "/v1/live/sessions";
export const LIVE_WS_URL = "wss://api.openai.com/v1/live/sessions";
export const DEFAULT_LIVE_VOICE = "marin";

/** The voices the vendor lists for gpt-live-1 (default first). */
export const LIVE_VOICES = [
  "marin",
  "cedar",
  "quartz",
  "ripple",
  "vesper",
  "willow",
  "stone",
  "gleam",
  "meridian",
  "bossa",
  "tempo",
  "beacon",
  "delta",
  "cinder",
] as const;

/** Hard cap on one append's `content`, enforced server-side as
 * `invalid_value "Context append text must not exceed 500 tokens."` */
export const APPEND_TOKEN_LIMIT = 500;

/** Any event on the wire. Known ones narrow via {@link LiveServerEvent}. */
export interface LiveEvent {
  type: string;
  event_id?: string;
  [key: string]: unknown;
}

// ── session configuration ────────────────────────────────────────────────────

export interface LivePcmFormat {
  type: "audio/pcm";
  rate: 24000 | 16000;
}
export interface LiveG711Format {
  type: "audio/pcmu" | "audio/pcma";
  rate: 8000;
}
export interface LiveAudioConfig {
  /** WebSocket only — omit on WebRTC (the media tracks negotiate their own). */
  format?: LivePcmFormat | LiveG711Format;
  output?: { voice?: string };
}

/** A seed message (`input`, startup only, ≤ 128 messages / 8,192 tokens). */
export interface LiveInputMessage {
  role: "developer" | "user" | "assistant";
  content: Array<{ type: "input_text" | "output_text"; text: string }>;
}

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

/** A tool as the Responses backend sees it. Function tools carry a JSON
 * schema; hosted tools (`web_search`) are bare type records. */
export type LiveBackendTool =
  | {
      type: "function";
      name: string;
      description?: string;
      parameters?: Record<string, unknown>;
      strict?: boolean;
    }
  | { type: "web_search"; [key: string]: unknown }
  | { type: string; [key: string]: unknown };

/** `session.delegation.responses` — the hosted backend. Updatable mid-session
 * via `session.update { session: { delegation: { responses: … } } }`. */
export interface LiveResponsesDelegation {
  model: string;
  instructions?: string;
  tools?: LiveBackendTool[];
  tool_choice?: "auto" | "none" | "required" | Record<string, unknown>;
  parallel_tool_calls?: boolean;
  /** ≥ 16. */
  max_output_tokens?: number;
  service_tier?: "auto" | "default" | "flex" | "priority";
  reasoning?: { effort?: ReasoningEffort; summary?: "auto" | "concise" | "detailed" };
  text?: Record<string, unknown>;
}

export type LiveDelegationConfig =
  | { type: "client" }
  | { type: "responses"; responses: LiveResponsesDelegation };

/** The `session` object: `session.start` over WebSocket, the POST body's
 * `session` over WebRTC. */
export interface LiveSessionConfig {
  model?: string;
  /** ≤ 16,384 tokens. Append-only after start. */
  instructions?: string;
  input?: LiveInputMessage[];
  audio?: LiveAudioConfig;
  /** Omitted/null = client delegation. The TYPE is frozen for the session. */
  delegation?: LiveDelegationConfig | null;
  /** true = a 30-day stereo recording, downloadable and forkable. Default false. */
  store?: boolean;
}

// ── client events ────────────────────────────────────────────────────────────

export type AppendKind = "instructions" | "thinking" | "commentary";

export const APPEND_EVENT: Record<AppendKind, string> = {
  instructions: "session.instructions.append",
  thinking: "session.thinking.append",
  commentary: "session.commentary.append",
};

export const APPENDED_EVENT: Record<AppendKind, string> = {
  instructions: "session.instructions.appended",
  thinking: "session.thinking.appended",
  commentary: "session.commentary.appended",
};

/** Map an ack type back to its kind (undefined for anything else). */
export function appendKindOfAck(type: string): AppendKind | undefined {
  for (const kind of Object.keys(APPENDED_EVENT) as AppendKind[]) {
    if (APPENDED_EVENT[kind] === type) {
      return kind;
    }
  }
  return undefined;
}

export interface AppendEvent extends LiveEvent {
  type: string;
  event_id: string;
  /** null = session-wide; otherwise a delegation id the session knows. */
  delegation_id: string | null;
  content: string;
}

export function appendEvent(
  kind: AppendKind,
  eventId: string,
  delegationId: string | null,
  content: string,
): AppendEvent {
  return { type: APPEND_EVENT[kind], event_id: eventId, delegation_id: delegationId, content };
}

// ── server events ────────────────────────────────────────────────────────────

export interface LiveSessionRecord {
  id: string;
  /** Unix seconds. Measured ≈ 2 h after start. */
  expires_at?: number;
  status?: string;
  model?: string;
  [key: string]: unknown;
}

export interface LiveDelegationRecord {
  id: string;
  type: "delegation";
  target: "client" | "responses";
  /** Responses mode: the hosted response this delegation opened. */
  response_id?: string;
}

export type LiveCloseReason =
  | "close_requested"
  | "expired"
  | "content"
  | "remote_hangup"
  | "connection_lost"
  | (string & {});

export interface SessionStartedEvent extends LiveEvent {
  type: "session.started";
  session: LiveSessionRecord;
}
export interface SessionUpdatedEvent extends LiveEvent {
  type: "session.updated";
  session: LiveSessionRecord;
}
export interface SessionUsageUpdatedEvent extends LiveEvent {
  type: "session.usage.updated";
  usage: { seconds: number };
  context_window?: { usage_ratio?: number };
}
export interface SessionClosedEvent extends LiveEvent {
  type: "session.closed";
  reason: LiveCloseReason;
  usage?: { seconds: number };
  session?: LiveSessionRecord;
}
export interface DelegationCreatedEvent extends LiveEvent {
  type: "session.delegation.created";
  /** Session-timeline ms; lands on the user's last word. */
  offset_ms?: number;
  delegation: LiveDelegationRecord;
}
/** Responses mode: one hosted Responses streaming event, nested. */
export interface ResponseEventEvent extends LiveEvent {
  type: "response.event";
  delegation_id: string;
  event: { type: string; [key: string]: unknown };
}
export interface AppendedEvent extends LiveEvent {
  client_event_id: string;
  start_ms?: number;
  end_ms?: number;
}
export interface TranscriptDeltaEvent extends LiveEvent {
  type: "session.input_transcript.delta" | "session.output_transcript.delta";
  delta: string;
  start_ms?: number;
  end_ms?: number;
}
export interface OutputAudioDeltaEvent extends LiveEvent {
  type: "session.output_audio.delta";
  /** base64 PCM at the negotiated rate. Continuous — silence included. */
  delta: string;
  start_ms?: number;
  end_ms?: number;
}
export interface LiveErrorEvent extends LiveEvent {
  type: "error";
  error: {
    type?: string;
    code?: string | null;
    message?: string;
    param?: string | null;
    client_event_id?: string | null;
  };
}

export type LiveServerEvent =
  | SessionStartedEvent
  | SessionUpdatedEvent
  | SessionUsageUpdatedEvent
  | SessionClosedEvent
  | DelegationCreatedEvent
  | ResponseEventEvent
  | TranscriptDeltaEvent
  | OutputAudioDeltaEvent
  | LiveErrorEvent
  | LiveEvent;

// ── Responses-mode helpers ───────────────────────────────────────────────────

export interface FunctionCallItem {
  callId: string;
  name: string;
  /** The raw JSON text the model produced. */
  arguments: string;
}

/** Read a completed function call out of a nested Responses event, if it is one. */
export function functionCallFromResponseEvent(ev: LiveEvent): FunctionCallItem | undefined {
  if (ev.type !== "response.event") {
    return undefined;
  }
  const nested = (ev as ResponseEventEvent).event;
  if (nested?.type !== "response.output_item.done") {
    return undefined;
  }
  const item = nested.item as Record<string, unknown> | undefined;
  if (item?.type !== "function_call") {
    return undefined;
  }
  const callId = item.call_id;
  const name = item.name;
  if (typeof callId !== "string" || typeof name !== "string") {
    return undefined;
  }
  return { callId, name, arguments: typeof item.arguments === "string" ? item.arguments : "{}" };
}

/** The final text of a completed hosted response, if the event carries it. */
export function outputTextFromResponseEvent(ev: LiveEvent): string | undefined {
  if (ev.type !== "response.event") {
    return undefined;
  }
  const nested = (ev as ResponseEventEvent).event;
  if (nested?.type !== "response.completed") {
    return undefined;
  }
  const response = nested.response as { output?: unknown[] } | undefined;
  const parts: string[] = [];
  for (const item of response?.output ?? []) {
    const record = item as { type?: string; content?: Array<{ type?: string; text?: string }> };
    if (record.type === "message") {
      for (const part of record.content ?? []) {
        if (part.type === "output_text" && typeof part.text === "string") {
          parts.push(part.text);
        }
      }
    }
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

/** The two events that answer a hosted function call. Send both, in order. */
export function functionCallOutputEvents(
  callId: string,
  output: unknown,
  eventId: string,
): [LiveEvent, LiveEvent] {
  return [
    {
      type: "response.item.create",
      event_id: eventId,
      item: {
        type: "function_call_output",
        call_id: callId,
        output: typeof output === "string" ? output : JSON.stringify(output ?? null),
      },
    },
    { type: "response.create", event_id: `${eventId}_go` },
  ];
}

/** Typed input for a hosted backend: a user message item, then a response. */
export function typedInputEvents(text: string, eventId: string): [LiveEvent, LiveEvent] {
  return [
    {
      type: "response.item.create",
      event_id: eventId,
      item: { type: "message", role: "user", content: [{ type: "input_text", text }] },
    },
    { type: "response.create", event_id: `${eventId}_go` },
  ];
}
