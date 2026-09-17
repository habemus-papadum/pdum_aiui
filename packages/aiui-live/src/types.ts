/**
 * types.ts — the package's shared vocabulary above the wire: tools, the
 * transcript, tasks, the state a widget renders, the ledger, and the two
 * seams every host plugs into — the TRANSPORT (how audio and events move) and
 * the DELEGATOR (who does the thinking).
 *
 * Contract of record: docs/proposals/oracle-live.md §6–§7. The oracle's
 * vocabulary (`heard`/`said`/`response`) is deliberately NOT reused: Live has
 * fragment transcripts with no turn boundaries, tickets instead of tool calls,
 * and seconds instead of tokens.
 */

import type { AppendKind, LiveBackendTool, LiveEvent, LiveSessionConfig } from "./protocol";

// ── tools ────────────────────────────────────────────────────────────────────

/**
 * A tool a backend may call — executed wherever the tool lives (the page for
 * an aiui control, the server for a file read). Structurally identical to
 * the oracle's `OracleTool`, so `toolsFromControlSurface()` output drops in.
 */
export interface LiveTool {
  name: string;
  description: string;
  /** JSON Schema for the arguments. */
  parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>): unknown | Promise<unknown>;
}

/** A tool without its executor — what crosses a wire. */
export interface LiveToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export function toolSpec(tool: LiveTool | LiveToolSpec): LiveToolSpec {
  return { name: tool.name, description: tool.description, parameters: tool.parameters };
}

/** The Responses-API function-tool shape for a tool. */
export function backendToolFor(tool: LiveTool | LiveToolSpec): LiveBackendTool {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  };
}

/** Run a tool defensively: bad JSON and thrown errors become `{ error }`
 * outputs the model can read (there is no error channel for tools). */
export async function runTool(
  tools: readonly LiveTool[],
  name: string,
  args: string | Record<string, unknown>,
): Promise<unknown> {
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined) {
    return { error: `unknown tool ${name}` };
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = typeof args === "string" ? (JSON.parse(args === "" ? "{}" : args) as never) : args;
  } catch {
    return { error: `arguments for ${name} were not valid JSON` };
  }
  try {
    const result = await tool.execute(parsed);
    return result === undefined ? { ok: true } : result;
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

// ── transcript ───────────────────────────────────────────────────────────────

/** One `*_transcript.delta`, as received. */
export interface TranscriptSegment {
  text: string;
  /** Session-timeline ms (absent on some fragments). */
  startMs?: number;
  endMs?: number;
  /** Wall ms since connect, when it arrived. */
  t: number;
}

/** Fragments regrouped by silence gaps — the closest Live gets to a turn. */
export interface Utterance {
  text: string;
  startMs: number;
  endMs: number;
  /** Arrival of the first fragment, ms since connect. */
  t: number;
  /** Arrival of the last fragment. */
  tEnd: number;
}

export interface TranscriptSnapshot {
  user: Utterance[];
  assistant: Utterance[];
}

// ── tasks (delegations) ──────────────────────────────────────────────────────

export type TaskStatus = "open" | "done" | "failed" | "cancelled";

export interface TaskAppend {
  kind: AppendKind;
  content: string;
  eventId: string;
  /** Sent, ms since connect. */
  t: number;
  /** Acked, ms since connect (absent until the `…appended` echo). */
  ackT?: number;
  error?: string;
}

/**
 * A delegation ticket and everything that happened on it. `id` is the
 * vendor's `item_…` for a real delegation, or `local_…` for typed input
 * handled in client mode (its appends go out with `delegation_id: null`).
 */
export interface LiveTask {
  id: string;
  seq: number;
  target: "client" | "responses" | "local";
  responseId?: string;
  /** ms since connect. */
  createdAt: number;
  /** Session-timeline ms of the delegation (lands on the user's last word). */
  offsetMs?: number;
  status: TaskStatus;
  /** What the user asked — our best reconstruction from the transcript. */
  request: string;
  appends: TaskAppend[];
  /** ms since connect: first append sent / first spoken word after it / done. */
  firstAppendT?: number;
  firstSpokenT?: number;
  doneAt?: number;
  result?: string;
  error?: string;
  /** The delegator that handled it. */
  backend?: string;
  /** Backend progress lines (never spoken; the UI's "what is it doing"). */
  log: Array<{ t: number; line: string }>;
}

/** Derived timings for a task, in ms (undefined until the milestone exists). */
export function taskTimings(task: LiveTask): {
  toFirstAppendMs?: number;
  appendToSpokenMs?: number;
  totalMs?: number;
} {
  return {
    toFirstAppendMs:
      task.firstAppendT === undefined ? undefined : task.firstAppendT - task.createdAt,
    appendToSpokenMs:
      task.firstSpokenT === undefined || task.firstAppendT === undefined
        ? undefined
        : task.firstSpokenT - task.firstAppendT,
    totalMs: task.doneAt === undefined ? undefined : task.doneAt - task.createdAt,
  };
}

// ── state + ledger ───────────────────────────────────────────────────────────

export type LiveStatus = "idle" | "connecting" | "live" | "closing" | "closed" | "error";

export interface LiveCaptions {
  user: string;
  assistant: string;
}

export interface LiveState {
  status: LiveStatus;
  transport: string;
  delegator: string;
  sessionId?: string;
  /** Epoch ms. */
  startedAt?: number;
  /** Epoch ms (from `expires_at`). */
  expiresAt?: number;
  /** Billed seconds so far (cumulative, from `session.usage.updated`). */
  seconds: number;
  /** 0–1, from `context_window.usage_ratio`. */
  contextRatio: number;
  muted: boolean;
  userSpeaking: boolean;
  assistantSpeaking: boolean;
  captions: LiveCaptions;
  tasks: LiveTask[];
  openTasks: number;
  error?: string;
  closeReason?: string;
  playbackBlocked: boolean;
  /** How many times this object has started a session. */
  starts: number;
  /** ms since connect of the last server event. */
  lastEventT?: number;
  /** Bytes of output audio received (WebSocket transports only). */
  audioOutBytes: number;
}

export type LedgerDir = "in" | "out" | "local";
export type LedgerKind =
  | "session"
  | "transcript"
  | "delegation"
  | "append"
  | "ack"
  | "usage"
  | "response"
  | "error"
  | "backend"
  | "note"
  | "raw";

export interface LedgerEntry {
  seq: number;
  /** ms since connect (negative before `session.started`). */
  t: number;
  /** Epoch ms. */
  at: number;
  dir: LedgerDir;
  kind: LedgerKind;
  summary: string;
  delegationId?: string;
  event?: Record<string, unknown>;
}

// ── the transport seam ───────────────────────────────────────────────────────

export interface TransportConnectOptions {
  session: LiveSessionConfig;
  onEvent(event: LiveEvent): void;
  onClose(reason: string): void;
  /** WebRTC: reply playback was blocked by autoplay policy. */
  onPlaybackBlocked?(): void;
  audioElement?: HTMLAudioElement;
}

export interface TransportHandle {
  send(event: LiveEvent): void;
  /** Gate the microphone locally (the session ALSO sends the mute event). */
  setMicEnabled(on: boolean): void;
  close(): void;
  /** Known before `session.started` on WebRTC (from the POST answer). */
  sessionId?: string;
  micStream?: MediaStream;
}

export interface LiveTransport {
  name: string;
  connect(options: TransportConnectOptions): Promise<TransportHandle>;
}

// ── the delegation seam ──────────────────────────────────────────────────────

/**
 * One delegation, handed to a {@link Delegator}. Transport-neutral on
 * purpose: the same object is built by the session in the browser and by the
 * relay on a server, so a delegator never knows which side it runs on.
 */
export interface DelegationRequest {
  id: string;
  /** What the user asked (the user transcript since the previous delegation). */
  text: string;
  transcript: TranscriptSnapshot;
  /** Tools the backend may call; executed wherever they live. */
  tools: LiveTool[];
  /** Aborted on cancel or session close. */
  signal: AbortSignal;
  /** Spoken to the user (paraphrased by the voice model). */
  say(text: string): Promise<void>;
  /** Quiet facts for the voice model — not spoken unless asked. */
  note(text: string): Promise<void>;
  /** A trusted directive — can interrupt speech. */
  steer(text: string): Promise<void>;
  /** A progress line for the UI, never spoken. */
  log(line: string): void;
}

export interface Delegator {
  name: string;
  describe?(): string;
  /**
   * Handle one delegation. Speak through `req.say`; resolve when done. A
   * returned string is spoken only if nothing was said during the handling
   * (the "final answer" convenience). A rejection marks the task failed.
   */
  // biome-ignore lint/suspicious/noConfusingVoidType: an `async handle(req) { … }` with no return is Promise<void>, and that is the common delegator
  handle(req: DelegationRequest): Promise<string | undefined | void>;
  dispose?(): void;
}

// ── prompt slots ─────────────────────────────────────────────────────────────

/** The live prompt's structured modification points — see {@link ../prompt}. */
export interface LivePromptSlots {
  /** Standing: what this app IS, and what matters in it. */
  app?: string;
  /** How to behave this conversation. */
  stance?: string;
  /** What the backend can do, as the voice model should describe it. */
  backendTools?: string;
  /** Bullet lines: when to delegate. */
  delegateWhen?: string;
  /** Bullet lines: when NOT to delegate. */
  dontDelegateWhen?: string;
  /** Verbatim extra guidance. */
  extra?: string;
}
