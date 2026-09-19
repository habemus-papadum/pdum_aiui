/**
 * session.ts — the live engine: one GPT-Live session over a pluggable
 * transport, with the bookkeeping the vendor leaves to the application.
 *
 * What the session OWNS (docs/proposals/oracle-live.md §6):
 *  - the TASK TABLE: every `session.delegation.created` becomes a ticket; the
 *    delegator answers on that id; timings (created → first append → first
 *    spoken word → done) are recorded, because the wire never says "this
 *    speech was that append";
 *  - the APPEND/ACK ledger: every append carries a client `event_id`; the
 *    `…appended` echo (or an `error` naming that id) settles it; long text is
 *    chunked under the 500-token cap;
 *  - the TRANSCRIPT: two fragment tracks, regrouped by silence, from which a
 *    request's text, the captions, and a resume seed are derived;
 *  - PROGRESS: a task that has said nothing for a while gets a "still
 *    working" line — the voice model stays silent otherwise, measured;
 *  - the IDLE lifecycle: silence is billed, so an idle session CLOSES and the
 *    next start re-seeds it from our own transcript (`input`).
 *
 * What it deliberately does NOT do: play audio (the transport's job), decide
 * what to say (the delegator's), or know which side of a wire it is on.
 */

import { livePrompt } from "./prompt";
import {
  APPENDED_EVENT,
  type AppendKind,
  appendEvent,
  appendKindOfAck,
  DEFAULT_LIVE_VOICE,
  type DelegationCreatedEvent,
  functionCallFromResponseEvent,
  functionCallOutputEvents,
  LIVE_MODEL,
  type LiveAudioConfig,
  type LiveDelegationConfig,
  type LiveErrorEvent,
  type LiveEvent,
  type LiveInputMessage,
  type LiveResponsesDelegation,
  type LiveSessionConfig,
  outputTextFromResponseEvent,
  type ResponseEventEvent,
  type SessionClosedEvent,
  type SessionStartedEvent,
  type SessionUsageUpdatedEvent,
  type TranscriptDeltaEvent,
  typedInputEvents,
} from "./protocol";
import { approxTokens, chunkForAppend } from "./tokens";
import { interleave, TranscriptTrack } from "./transcript";
import {
  backendToolFor,
  type DelegationRequest,
  type Delegator,
  type LedgerDir,
  type LedgerEntry,
  type LedgerKind,
  type LivePromptSlots,
  type LiveState,
  type LiveTask,
  type LiveTool,
  type LiveTransport,
  runTool,
  type TranscriptSnapshot,
  type TransportHandle,
} from "./types";

export interface LiveConfig {
  /** Default {@link LIVE_MODEL}. */
  model?: string;
  /** A finished prompt, or slots woven by {@link livePrompt}. */
  instructions?: string | LivePromptSlots;
  /** Default `marin`. */
  voice?: string;
  /** Default client delegation. The TYPE is frozen for the session's life. */
  delegation?: LiveDelegationConfig;
  store?: boolean;
  /** An explicit seed (wins over the idle re-seed). */
  input?: LiveInputMessage[];
  /** WebSocket transports need `format`; WebRTC must leave it out. */
  audio?: LiveAudioConfig;
}

export interface LiveSessionOptions {
  transport: LiveTransport;
  config?: LiveConfig;
  /** Who answers client delegations. Swappable between tasks. */
  delegator?: Delegator;
  /** Tools a backend may call. In Responses mode without explicit
   * `responses.tools`, these are registered as the hosted function tools. */
  tools?: LiveTool[];
  /** Speak a progress line when a task has been quiet this long. */
  progress?: { afterMs?: number; text?: string } | false;
  /** Close after this much silence with no open task; re-seed on the next start. */
  idle?: { closeAfterSeconds?: number; reseed?: boolean } | false;
  /** What to say when a delegator throws. `false` = nothing. */
  failureText?: string | false;
  ackTimeoutMs?: number;
  startTimeoutMs?: number;
  /** Silence that separates two utterances in the transcript view. */
  gapMs?: number;
  now?: () => number;
  audioElement?: HTMLAudioElement;
}

export interface AppendReceipt {
  eventId: string;
  acked: boolean;
  startMs?: number;
  endMs?: number;
  error?: string;
}

export const DEFAULT_PROGRESS_AFTER_MS = 9000;
export const DEFAULT_PROGRESS_TEXT = "Still working on it.";
export const DEFAULT_IDLE_CLOSE_SECONDS = 120;
export const DEFAULT_FAILURE_TEXT = "I couldn't finish that one.";
/** Re-seed budget: the vendor caps `input` at 8,192 tokens; leave headroom. */
export const RESEED_TOKEN_BUDGET = 6000;

interface PendingAppend {
  settle(receipt: AppendReceipt): void;
  taskId?: string;
  kind: AppendKind;
  timer: ReturnType<typeof setTimeout>;
}

const SPEAKING_HOLD_MS = { user: 700, assistant: 900 };

export class LiveSession {
  readonly transport: LiveTransport;
  private readonly options: LiveSessionOptions;
  private handle: TransportHandle | undefined;
  private readonly entries: LedgerEntry[] = [];
  private readonly ledgerListeners = new Set<(entry: LedgerEntry) => void>();
  private readonly stateListeners = new Set<(state: LiveState) => void>();
  private readonly taskListeners = new Set<(task: LiveTask) => void>();
  private readonly tasksById = new Map<string, LiveTask>();
  private readonly aborts = new Map<string, AbortController>();
  private readonly progressTimers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly pending = new Map<string, PendingAppend>();
  private user: TranscriptTrack;
  private assistant: TranscriptTrack;
  private delegator: Delegator | undefined;
  private tools: LiveTool[];
  private seq = 0;
  private taskSeq = 0;
  private t0 = 0;
  private lastDelegationT = -1;
  private wire: LiveSessionConfig | undefined;
  private reseed: TranscriptSnapshot | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private speakingTimers: {
    user?: ReturnType<typeof setTimeout>;
    assistant?: ReturnType<typeof setTimeout>;
  } = {};
  private started: { resolve(): void; reject(error: Error): void } | undefined;
  private closing: (() => void) | undefined;
  private notifyScheduled = false;
  private readonly s: LiveState;

  constructor(options: LiveSessionOptions) {
    this.options = options;
    this.transport = options.transport;
    this.delegator = options.delegator;
    this.tools = options.tools ?? [];
    this.user = new TranscriptTrack(options.gapMs);
    this.assistant = new TranscriptTrack(options.gapMs);
    this.s = {
      status: "idle",
      transport: options.transport.name,
      delegator: options.delegator?.name ?? "none",
      seconds: 0,
      contextRatio: 0,
      muted: false,
      userSpeaking: false,
      assistantSpeaking: false,
      captions: { user: "", assistant: "" },
      tasks: [],
      openTasks: 0,
      playbackBlocked: false,
      starts: 0,
      audioOutBytes: 0,
    };
  }

  // ── observation ────────────────────────────────────────────────────────────

  /** A snapshot by VALUE: tasks are copied, so a widget comparing snapshots
   * sees a changed task as a new object (the engine mutates tasks in place). */
  state(): LiveState {
    return {
      ...this.s,
      captions: { ...this.s.captions },
      tasks: this.s.tasks.map((task) => ({
        ...task,
        appends: [...task.appends],
        log: [...task.log],
      })),
    };
  }

  onState(listener: (state: LiveState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  ledger(): readonly LedgerEntry[] {
    return this.entries;
  }

  onLedger(listener: (entry: LedgerEntry) => void): () => void {
    this.ledgerListeners.add(listener);
    return () => this.ledgerListeners.delete(listener);
  }

  /** Fires on every task creation and change. */
  onTask(listener: (task: LiveTask) => void): () => void {
    this.taskListeners.add(listener);
    return () => this.taskListeners.delete(listener);
  }

  tasks(): readonly LiveTask[] {
    return this.s.tasks;
  }

  task(id: string): LiveTask | undefined {
    return this.tasksById.get(id);
  }

  transcript(): TranscriptSnapshot {
    return { user: this.user.utterances(), assistant: this.assistant.utterances() };
  }

  /** The wire config of the current (or last) session. */
  sessionConfig(): LiveSessionConfig | undefined {
    return this.wire;
  }

  micStream(): MediaStream | undefined {
    return this.handle?.micStream;
  }

  /** ms since connect. */
  now(): number {
    return (this.options.now ?? Date.now)() - this.t0;
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.s.status === "connecting" || this.s.status === "live" || this.s.status === "closing") {
      return;
    }
    this.resetForStart();
    this.s.status = "connecting";
    this.s.starts += 1;
    this.s.error = undefined;
    this.s.closeReason = undefined;
    this.bump();
    const session = this.composeWire();
    this.wire = session;
    this.record("out", "session", `connect via ${this.transport.name}`, { session });
    const startTimeout = this.options.startTimeoutMs ?? 20000;
    try {
      const startedPromise = new Promise<void>((resolve, reject) => {
        this.started = { resolve, reject };
      });
      const timer = setTimeout(
        () => this.started?.reject(new Error(`no session.started within ${startTimeout} ms`)),
        startTimeout,
      );
      this.handle = await this.transport.connect({
        session,
        onEvent: (event) => this.onEvent(event),
        onClose: (reason) => this.onTransportClose(reason),
        onPlaybackBlocked: () => {
          this.s.playbackBlocked = true;
          this.bump();
        },
        audioElement: this.options.audioElement,
      });
      if (this.handle.sessionId !== undefined) {
        this.s.sessionId = this.handle.sessionId;
      }
      await startedPromise.finally(() => clearTimeout(timer));
    } catch (error) {
      this.s.status = "error";
      this.s.error = error instanceof Error ? error.message : String(error);
      this.record("local", "error", this.s.error);
      this.handle?.close();
      this.handle = undefined;
      this.bump();
      throw error;
    } finally {
      this.started = undefined;
    }
  }

  /** Ask the server to close; resolves on `session.closed` (or a short timeout). */
  async close(reason = "close_requested"): Promise<void> {
    if (this.handle === undefined || this.s.status === "closed" || this.s.status === "idle") {
      return;
    }
    if (this.s.status === "live") {
      this.s.status = "closing";
      this.s.closeReason = reason;
      this.bump();
      this.record("out", "session", `close (${reason})`);
      const closed = new Promise<void>((resolve) => {
        this.closing = resolve;
      });
      this.send({ type: "session.close" });
      const timer = setTimeout(() => this.closing?.(), 5000);
      await closed;
      clearTimeout(timer);
      this.closing = undefined;
    }
    this.finish(this.s.closeReason ?? reason);
  }

  /** Mute both ways: the mic track locally AND the server-side mute event. */
  mute(on: boolean): void {
    this.handle?.setMicEnabled(!on);
    this.send({ type: on ? "session.input_audio.mute" : "session.input_audio.unmute" });
    this.s.muted = on;
    this.record("out", "session", on ? "mute" : "unmute");
    this.bump();
  }

  setDelegator(delegator: Delegator | undefined): void {
    this.delegator = delegator;
    this.s.delegator = delegator?.name ?? "none";
    this.record("local", "note", `delegator → ${this.s.delegator}`);
    this.bump();
  }

  currentDelegator(): Delegator | undefined {
    return this.delegator;
  }

  setTools(tools: LiveTool[]): void {
    this.tools = tools;
    this.record("local", "note", `tools → ${tools.length}`);
  }

  currentTools(): readonly LiveTool[] {
    return this.tools;
  }

  /** Responses mode only: patch the hosted backend mid-session. Unverified
   * for `tools` at the time of writing — watch the `session.updated` echo. */
  updateResponses(patch: Partial<LiveResponsesDelegation>): void {
    this.send({ type: "session.update", session: { delegation: { responses: patch } } });
    this.record("out", "session", `session.update responses ${Object.keys(patch).join(",")}`);
  }

  // ── speaking back ──────────────────────────────────────────────────────────

  say(text: string, options: { delegationId?: string | null } = {}): Promise<AppendReceipt> {
    return this.append("commentary", text, options.delegationId);
  }

  note(text: string, options: { delegationId?: string | null } = {}): Promise<AppendReceipt> {
    return this.append("thinking", text, options.delegationId);
  }

  steer(text: string, options: { delegationId?: string | null } = {}): Promise<AppendReceipt> {
    return this.append("instructions", text, options.delegationId);
  }

  /**
   * Typed input. Client mode: a local task the delegator answers
   * (`delegation_id: null` on the wire). Responses mode: a user message item
   * for the hosted backend.
   */
  sendText(text: string): void {
    const trimmed = text.trim();
    if (trimmed === "") {
      return;
    }
    if (this.wire?.delegation?.type === "responses") {
      const id = this.nextEventId();
      for (const event of typedInputEvents(trimmed, id)) {
        this.send(event);
      }
      this.record("out", "note", `typed → backend: ${trimmed}`);
      return;
    }
    const task = this.openTask({
      id: `local_${this.taskSeq + 1}`,
      target: "local",
      request: trimmed,
    });
    this.runDelegator(task);
  }

  cancelTask(id: string, reason = "cancelled"): void {
    const task = this.tasksById.get(id);
    if (task === undefined || task.status !== "open") {
      return;
    }
    task.status = "cancelled";
    task.doneAt = this.now();
    task.error = reason;
    this.aborts.get(id)?.abort();
    this.stopProgress(id);
    this.record("local", "delegation", `cancelled ${id} (${reason})`, undefined, id);
    this.touchTask(task);
  }

  completeTask(id: string, result?: string): void {
    const task = this.tasksById.get(id);
    if (task === undefined || task.status !== "open") {
      return;
    }
    task.status = "done";
    task.doneAt = this.now();
    if (result !== undefined) {
      task.result = result;
    }
    this.stopProgress(id);
    this.record("local", "delegation", `done ${id}`, undefined, id);
    this.touchTask(task);
    this.armIdle();
  }

  failTask(id: string, error: string): void {
    const task = this.tasksById.get(id);
    if (task === undefined || task.status !== "open") {
      return;
    }
    task.status = "failed";
    task.doneAt = this.now();
    task.error = error;
    this.stopProgress(id);
    this.record("local", "error", `failed ${id}: ${error}`, undefined, id);
    this.touchTask(task);
    this.armIdle();
  }

  /** The `input` a re-seeded start would send, from the last session's transcript. */
  reseedInput(): LiveInputMessage[] | undefined {
    const snapshot = this.reseed;
    if (snapshot === undefined) {
      return undefined;
    }
    const script = interleave(snapshot.user, snapshot.assistant);
    const kept: LiveInputMessage[] = [];
    let budget = RESEED_TOKEN_BUDGET;
    for (let i = script.length - 1; i >= 0; i--) {
      const line = script[i];
      if (line === undefined) {
        continue;
      }
      budget -= approxTokens(line.text);
      if (budget < 0) {
        break;
      }
      kept.unshift(
        line.role === "user"
          ? { role: "user", content: [{ type: "input_text", text: line.text }] }
          : { role: "assistant", content: [{ type: "output_text", text: line.text }] },
      );
    }
    if (kept.length === 0) {
      return undefined;
    }
    return [
      {
        role: "developer",
        content: [
          {
            type: "input_text",
            text: "The conversation below happened moments ago in this same session, before a pause. Continue naturally; do not greet again.",
          },
        ],
      },
      ...kept,
    ];
  }

  // ── internals: wiring ──────────────────────────────────────────────────────

  private composeWire(): LiveSessionConfig {
    const config = this.options.config ?? {};
    const instructions =
      typeof config.instructions === "string"
        ? config.instructions
        : livePrompt(config.instructions);
    let delegation: LiveDelegationConfig = config.delegation ?? { type: "client" };
    if (delegation.type === "responses" && delegation.responses.tools === undefined) {
      delegation = {
        type: "responses",
        responses: { ...delegation.responses, tools: this.tools.map(backendToolFor) },
      };
    }
    const audio: LiveAudioConfig = {
      ...config.audio,
      output: {
        ...config.audio?.output,
        voice: config.voice ?? config.audio?.output?.voice ?? DEFAULT_LIVE_VOICE,
      },
    };
    const idle = this.options.idle;
    const input =
      config.input ?? (idle === false || idle?.reseed === false ? undefined : this.reseedInput());
    return {
      model: config.model ?? LIVE_MODEL,
      instructions,
      audio,
      delegation,
      ...(config.store !== undefined ? { store: config.store } : {}),
      ...(input !== undefined ? { input } : {}),
    };
  }

  private resetForStart(): void {
    // Keep the last transcript as the re-seed, then start clean.
    if (this.user.segments.length > 0 || this.assistant.segments.length > 0) {
      this.reseed = this.transcript();
    }
    this.user = new TranscriptTrack(this.options.gapMs);
    this.assistant = new TranscriptTrack(this.options.gapMs);
    this.tasksById.clear();
    this.aborts.clear();
    for (const timer of this.progressTimers.values()) {
      clearInterval(timer);
    }
    this.progressTimers.clear();
    this.pending.clear();
    this.lastDelegationT = -1;
    this.t0 = (this.options.now ?? Date.now)();
    this.s.tasks = [];
    this.s.openTasks = 0;
    this.s.seconds = 0;
    this.s.contextRatio = 0;
    this.s.muted = false;
    this.s.sessionId = undefined;
    this.s.startedAt = undefined;
    this.s.expiresAt = undefined;
    this.s.captions = { user: "", assistant: "" };
    this.s.audioOutBytes = 0;
    this.s.lastEventT = undefined;
    this.s.playbackBlocked = false;
  }

  private send(event: LiveEvent): void {
    if (this.handle === undefined) {
      return;
    }
    this.handle.send(event);
  }

  private nextEventId(): string {
    return `c_${++this.seq}`;
  }

  private onEvent(event: LiveEvent): void {
    const t = this.now();
    this.s.lastEventT = t;
    switch (event.type) {
      case "session.started": {
        const started = event as SessionStartedEvent;
        this.s.status = "live";
        this.s.sessionId = started.session?.id ?? this.s.sessionId;
        this.s.startedAt = (this.options.now ?? Date.now)();
        this.s.expiresAt =
          typeof started.session?.expires_at === "number"
            ? started.session.expires_at * 1000
            : undefined;
        this.record("in", "session", `started ${this.s.sessionId ?? ""} (${t} ms)`, event);
        this.started?.resolve();
        this.armIdle();
        break;
      }
      case "session.updated":
        this.record("in", "session", "updated", event);
        break;
      case "session.usage.updated": {
        const usage = event as SessionUsageUpdatedEvent;
        this.s.seconds = usage.usage?.seconds ?? this.s.seconds;
        this.s.contextRatio = usage.context_window?.usage_ratio ?? this.s.contextRatio;
        this.record(
          "in",
          "usage",
          `${this.s.seconds}s · context ${(this.s.contextRatio * 100).toFixed(0)}%`,
          event,
        );
        break;
      }
      case "session.closed": {
        const closed = event as SessionClosedEvent;
        this.s.seconds = closed.usage?.seconds ?? this.s.seconds;
        this.record("in", "session", `closed (${closed.reason})`, event);
        this.closing?.();
        // We asked (idle, close_requested from the app): keep our reason;
        // the server's own reasons (expired, content, remote_hangup) win.
        this.finish(
          this.s.status === "closing" ? (this.s.closeReason ?? closed.reason) : closed.reason,
        );
        break;
      }
      case "session.delegation.created": {
        const created = event as DelegationCreatedEvent;
        const record = created.delegation;
        this.record(
          "in",
          "delegation",
          `${record.target} ${record.id} @${created.offset_ms ?? "?"}ms`,
          event,
          record.id,
        );
        const task = this.openTask({
          id: record.id,
          target: record.target,
          responseId: record.response_id,
          offsetMs: created.offset_ms,
          request: this.requestTextSince(this.lastDelegationT),
        });
        this.lastDelegationT = t;
        if (record.target === "client") {
          this.runDelegator(task);
        }
        break;
      }
      case "response.event":
        this.onResponseEvent(event as ResponseEventEvent);
        break;
      case "session.input_transcript.delta":
        this.onTranscript("user", event as TranscriptDeltaEvent, t);
        break;
      case "session.output_transcript.delta":
        this.onTranscript("assistant", event as TranscriptDeltaEvent, t);
        break;
      case "session.output_audio.delta": {
        const delta = event.delta;
        if (typeof delta === "string") {
          this.s.audioOutBytes += Math.floor((delta.length * 3) / 4);
        }
        break;
      }
      case "session.input_audio.muted":
        this.s.muted = true;
        this.record("in", "session", "muted", event);
        break;
      case "session.input_audio.unmuted":
        this.s.muted = false;
        this.record("in", "session", "unmuted", event);
        break;
      case "error":
        this.onError(event as LiveErrorEvent);
        break;
      default: {
        const kind = appendKindOfAck(event.type);
        if (kind !== undefined) {
          this.onAck(kind, event, t);
        } else {
          this.record("in", "raw", event.type, event);
        }
      }
    }
    this.bump();
  }

  private onTranscript(track: "user" | "assistant", event: TranscriptDeltaEvent, t: number): void {
    const target = track === "user" ? this.user : this.assistant;
    target.push({ text: event.delta, startMs: event.start_ms, endMs: event.end_ms, t });
    const last = target.utterances().at(-1);
    this.s.captions[track] = last?.text ?? "";
    this.record("in", "transcript", `${track}: ${event.delta}`, event);
    const key = track === "user" ? "userSpeaking" : "assistantSpeaking";
    this.s[key] = true;
    const existing = this.speakingTimers[track];
    if (existing !== undefined) {
      clearTimeout(existing);
    }
    this.speakingTimers[track] = setTimeout(() => {
      this.s[key] = false;
      this.bump();
    }, SPEAKING_HOLD_MS[track]);
    if (track === "user") {
      this.armIdle();
    } else {
      // Attribute the first spoken word after an append to that append's task:
      // the most recently appended task still waiting for speech.
      let candidate: LiveTask | undefined;
      for (const task of this.tasksById.values()) {
        if (
          task.firstAppendT !== undefined &&
          task.firstSpokenT === undefined &&
          task.firstAppendT <= t
        ) {
          if (candidate === undefined || task.firstAppendT > (candidate.firstAppendT ?? 0)) {
            candidate = task;
          }
        }
      }
      if (candidate !== undefined) {
        candidate.firstSpokenT = t;
        this.touchTask(candidate);
      }
    }
  }

  private onAck(kind: AppendKind, event: LiveEvent, t: number): void {
    const clientEventId = event.client_event_id;
    const pending = typeof clientEventId === "string" ? this.pending.get(clientEventId) : undefined;
    this.record("in", "ack", `${kind} ${clientEventId ?? "?"}`, event, pending?.taskId);
    if (pending === undefined || typeof clientEventId !== "string") {
      return;
    }
    this.pending.delete(clientEventId);
    clearTimeout(pending.timer);
    const task = pending.taskId === undefined ? undefined : this.tasksById.get(pending.taskId);
    const append = task?.appends.find((candidate) => candidate.eventId === clientEventId);
    if (append !== undefined) {
      append.ackT = t;
    }
    if (task !== undefined) {
      this.touchTask(task);
    }
    pending.settle({
      eventId: clientEventId,
      acked: true,
      startMs: typeof event.start_ms === "number" ? event.start_ms : undefined,
      endMs: typeof event.end_ms === "number" ? event.end_ms : undefined,
    });
  }

  private onError(event: LiveErrorEvent): void {
    const error = event.error ?? {};
    const message = `${error.code ?? error.type ?? "error"}: ${error.message ?? "?"}`;
    const clientEventId = error.client_event_id;
    const pending = typeof clientEventId === "string" ? this.pending.get(clientEventId) : undefined;
    this.record("in", "error", message, event, pending?.taskId);
    if (pending !== undefined && typeof clientEventId === "string") {
      this.pending.delete(clientEventId);
      clearTimeout(pending.timer);
      const task = pending.taskId === undefined ? undefined : this.tasksById.get(pending.taskId);
      const append = task?.appends.find((candidate) => candidate.eventId === clientEventId);
      if (append !== undefined) {
        append.error = message;
      }
      if (task !== undefined) {
        this.touchTask(task);
      }
      pending.settle({ eventId: clientEventId, acked: false, error: message });
      return;
    }
    this.s.error = message;
    if (this.started !== undefined) {
      this.started.reject(new Error(message));
    }
  }

  private onResponseEvent(event: ResponseEventEvent): void {
    const id = event.delegation_id;
    const nestedType = event.event?.type ?? "?";
    let task = this.tasksById.get(id);
    if (task === undefined) {
      task = this.openTask({
        id,
        target: "responses",
        request: this.requestTextSince(this.lastDelegationT),
      });
      this.lastDelegationT = this.now();
    }
    this.record("in", "response", nestedType, event, id);
    const call = functionCallFromResponseEvent(event);
    if (call !== undefined) {
      task.log.push({ t: this.now(), line: `call ${call.name}(${call.arguments})` });
      this.touchTask(task);
      void runTool(this.tools, call.name, call.arguments, {
        caller: "live:hosted",
        ref: task.id,
      }).then((output) => {
        const eventId = this.nextEventId();
        for (const reply of functionCallOutputEvents(call.callId, output, eventId)) {
          this.send(reply);
        }
        this.record(
          "out",
          "response",
          `${call.name} → ${JSON.stringify(output).slice(0, 120)}`,
          undefined,
          id,
        );
        task?.log.push({
          t: this.now(),
          line: `${call.name} → ${JSON.stringify(output).slice(0, 200)}`,
        });
        if (task !== undefined) {
          this.touchTask(task);
        }
      });
      return;
    }
    if (nestedType === "response.completed") {
      const response = event.event.response as { output?: Array<{ type?: string }> } | undefined;
      const stillCalling = (response?.output ?? []).some((item) => item.type === "function_call");
      if (!stillCalling) {
        this.completeTask(id, outputTextFromResponseEvent(event));
      }
      return;
    }
    if (nestedType === "response.failed" || nestedType === "response.incomplete") {
      this.failTask(id, nestedType);
    }
  }

  private onTransportClose(reason: string): void {
    if (this.s.status === "closed" || this.s.status === "idle") {
      return;
    }
    this.record("in", "session", `transport closed: ${reason}`);
    this.closing?.();
    this.finish(
      this.s.status === "closing" ? (this.s.closeReason ?? reason) : `connection_lost (${reason})`,
    );
  }

  private finish(reason: string): void {
    if (this.s.status === "closed") {
      return;
    }
    this.s.status = "closed";
    this.s.closeReason = reason;
    if (this.idleTimer !== undefined) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
    for (const task of this.tasksById.values()) {
      if (task.status === "open") {
        this.cancelTask(task.id, "session closed");
      }
    }
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.settle({ eventId: id, acked: false, error: "session closed" });
    }
    this.pending.clear();
    this.reseed = this.transcript();
    this.handle?.close();
    this.handle = undefined;
    this.bump();
  }

  // ── internals: tasks ───────────────────────────────────────────────────────

  private openTask(init: {
    id: string;
    target: LiveTask["target"];
    request: string;
    responseId?: string;
    offsetMs?: number;
  }): LiveTask {
    const task: LiveTask = {
      id: init.id,
      seq: ++this.taskSeq,
      target: init.target,
      responseId: init.responseId,
      createdAt: this.now(),
      offsetMs: init.offsetMs,
      status: "open",
      request: init.request,
      appends: [],
      log: [],
    };
    this.tasksById.set(task.id, task);
    this.s.tasks = [...this.s.tasks, task];
    this.touchTask(task);
    return task;
  }

  private touchTask(task: LiveTask): void {
    this.s.openTasks = this.s.tasks.filter((candidate) => candidate.status === "open").length;
    for (const listener of this.taskListeners) {
      listener(task);
    }
    this.bump();
  }

  private requestTextSince(t: number): string {
    const since = this.user.since(t);
    if (since.length > 0) {
      return since.map((utterance) => utterance.text).join(" ");
    }
    return this.user.utterances().at(-1)?.text ?? "";
  }

  private runDelegator(task: LiveTask): void {
    const delegator = this.delegator;
    if (delegator === undefined) {
      this.failTask(task.id, "no delegator");
      void this.speakFailure(task);
      return;
    }
    task.backend = delegator.name;
    const controller = new AbortController();
    this.aborts.set(task.id, controller);
    this.startProgress(task);
    const wireId = task.target === "local" ? null : task.id;
    const request: DelegationRequest = {
      id: task.id,
      text: task.request,
      transcript: this.transcript(),
      tools: this.tools,
      signal: controller.signal,
      say: async (text) => {
        await this.append("commentary", text, wireId, task.id);
      },
      note: async (text) => {
        await this.append("thinking", text, wireId, task.id);
      },
      steer: async (text) => {
        await this.append("instructions", text, wireId, task.id);
      },
      log: (line) => {
        task.log.push({ t: this.now(), line });
        this.record("local", "backend", line, undefined, task.id);
        this.touchTask(task);
      },
    };
    this.record(
      "local",
      "delegation",
      `→ ${delegator.name}: ${task.request || "(no transcript yet)"}`,
      undefined,
      task.id,
    );
    void Promise.resolve()
      .then(() => delegator.handle(request))
      .then(async (result) => {
        if (task.status !== "open") {
          return;
        }
        const spoke = task.appends.some((append) => append.kind === "commentary");
        if (typeof result === "string" && result.trim() !== "" && !spoke) {
          await this.append("commentary", result, wireId, task.id);
        }
        this.completeTask(task.id, typeof result === "string" ? result : undefined);
      })
      .catch(async (error: unknown) => {
        if (task.status !== "open") {
          return;
        }
        this.failTask(task.id, error instanceof Error ? error.message : String(error));
        await this.speakFailure(task);
      })
      .finally(() => {
        this.aborts.delete(task.id);
      });
  }

  private async speakFailure(task: LiveTask): Promise<void> {
    const text =
      this.options.failureText === undefined ? DEFAULT_FAILURE_TEXT : this.options.failureText;
    if (text === false || this.s.status !== "live") {
      return;
    }
    await this.append("commentary", text, task.target === "local" ? null : task.id, task.id);
  }

  private startProgress(task: LiveTask): void {
    const progress = this.options.progress;
    if (progress === false) {
      return;
    }
    const afterMs = progress?.afterMs ?? DEFAULT_PROGRESS_AFTER_MS;
    const text = progress?.text ?? DEFAULT_PROGRESS_TEXT;
    const timer = setInterval(
      () => {
        if (task.status !== "open" || this.s.status !== "live") {
          this.stopProgress(task.id);
          return;
        }
        const lastAppend = task.appends.at(-1)?.t ?? task.createdAt;
        if (this.now() - lastAppend >= afterMs) {
          void this.append("commentary", text, task.target === "local" ? null : task.id, task.id);
        }
      },
      Math.max(10, afterMs / 3),
    );
    this.progressTimers.set(task.id, timer);
  }

  private stopProgress(id: string): void {
    const timer = this.progressTimers.get(id);
    if (timer !== undefined) {
      clearInterval(timer);
      this.progressTimers.delete(id);
    }
  }

  // ── internals: appends ─────────────────────────────────────────────────────

  private async append(
    kind: AppendKind,
    text: string,
    delegationId: string | null | undefined,
    taskId?: string,
  ): Promise<AppendReceipt> {
    if (this.s.status !== "live") {
      return { eventId: "", acked: false, error: `session is ${this.s.status}` };
    }
    const wireId = delegationId ?? null;
    const resolvedTaskId =
      taskId ?? (delegationId !== null && delegationId !== undefined ? delegationId : undefined);
    const task = resolvedTaskId === undefined ? undefined : this.tasksById.get(resolvedTaskId);
    if (task !== undefined && task.status === "cancelled") {
      return { eventId: "", acked: false, error: "task cancelled" };
    }
    const chunks = chunkForAppend(text);
    let last: AppendReceipt = { eventId: "", acked: false, error: "empty text" };
    for (const chunk of chunks) {
      last = await this.appendOne(kind, chunk, wireId, task);
      if (last.error !== undefined) {
        break;
      }
    }
    return last;
  }

  private appendOne(
    kind: AppendKind,
    content: string,
    wireId: string | null,
    task: LiveTask | undefined,
  ): Promise<AppendReceipt> {
    const eventId = this.nextEventId();
    const t = this.now();
    const event = appendEvent(kind, eventId, wireId, content);
    if (task !== undefined) {
      task.appends.push({ kind, content, eventId, t });
      if (task.firstAppendT === undefined) {
        task.firstAppendT = t;
      }
      this.touchTask(task);
    }
    this.record(
      "out",
      "append",
      `${kind}${wireId === null ? "" : ` ${wireId}`}: ${content}`,
      event,
      task?.id,
    );
    this.armIdle();
    return new Promise<AppendReceipt>((resolve) => {
      const timeout = this.options.ackTimeoutMs ?? 10000;
      const timer = setTimeout(() => {
        this.pending.delete(eventId);
        this.record(
          "local",
          "note",
          `no ack for ${eventId} within ${timeout} ms`,
          undefined,
          task?.id,
        );
        resolve({ eventId, acked: false });
      }, timeout);
      this.pending.set(eventId, { settle: resolve, taskId: task?.id, kind, timer });
      this.send(event);
    });
  }

  // ── internals: idle ────────────────────────────────────────────────────────

  private armIdle(): void {
    const idle = this.options.idle;
    if (idle === false) {
      return;
    }
    if (this.idleTimer !== undefined) {
      clearTimeout(this.idleTimer);
    }
    const seconds = idle?.closeAfterSeconds ?? DEFAULT_IDLE_CLOSE_SECONDS;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (this.s.status !== "live") {
        return;
      }
      if (this.s.openTasks > 0) {
        this.armIdle();
        return;
      }
      this.record("local", "note", `idle for ${seconds}s — closing (re-seed on next start)`);
      void this.close("idle");
    }, seconds * 1000);
  }

  // ── internals: ledger + state ──────────────────────────────────────────────

  private record(
    dir: LedgerDir,
    kind: LedgerKind,
    summary: string,
    event?: LiveEvent | Record<string, unknown>,
    delegationId?: string,
  ): void {
    const entry: LedgerEntry = {
      seq: this.entries.length,
      t: this.now(),
      at: (this.options.now ?? Date.now)(),
      dir,
      kind,
      summary,
      ...(delegationId !== undefined ? { delegationId } : {}),
      ...(event !== undefined ? { event: event as Record<string, unknown> } : {}),
    };
    this.entries.push(entry);
    for (const listener of this.ledgerListeners) {
      listener(entry);
    }
  }

  private bump(): void {
    if (this.notifyScheduled) {
      return;
    }
    this.notifyScheduled = true;
    queueMicrotask(() => {
      this.notifyScheduled = false;
      const snapshot = this.state();
      for (const listener of this.stateListeners) {
        listener(snapshot);
      }
    });
  }
}

/** The ack event type for a kind — exported for transports/tests that fake echoes. */
export function appendedEventType(kind: AppendKind): string {
  return APPENDED_EVENT[kind];
}
