/**
 * session.ts — the chromeless session engine: config → credential → transport,
 * the vendor event stream normalized into the LEDGER, tool execution with the
 * completed-response gate, live tool/instruction updates reconciled against
 * `session.updated`, and PARK as a first-class state (mic gated, connection
 * open, $0 — idle bills nothing; the five-minute break is free).
 *
 * Hygiene rules from the research, enforced here so no caller has to know:
 *  - every client event carries our `event_id` (the only way to attribute a
 *    vendor `error` to the send that caused it);
 *  - `response.cancelled` does not exist — completion, cancellation, and
 *    failure all arrive as `response.done` with a `status`;
 *  - tool calls are read from `response.done` and execute ONLY when its
 *    status is `completed` — `function_call_arguments.done` fires for
 *    interrupted/cancelled responses too, and a cell write must not;
 *  - `voice` and `model` never ride a `session.update` (frozen fields);
 *  - unrecognized vendor events land in the ledger as `raw`, never dropped.
 */

import type {
  KeySource,
  LedgerBody,
  LedgerEntry,
  OracleConfig,
  OracleStatus,
  OracleTool,
  OracleTransport,
  TransportHandle,
  UsageTotals,
} from "./types";
import {
  DEFAULT_INPUT_TRANSCRIPTION_MODEL,
  DEFAULT_ORACLE_MODEL,
  DEFAULT_ORACLE_VOICE,
} from "./types";

export interface OracleState {
  status: OracleStatus;
  /** VAD says the human is talking (speech_started/stopped edges). */
  speaking: boolean;
  /** A response is in flight. */
  replying: boolean;
  /** The current reply's transcript, streamed (resets per response). */
  replyText: string;
  /** The tool executing RIGHT NOW — the "acting" cue for the mind strip.
   * (`| undefined` so the clear can ride a setState patch.) */
  runningTool?: string | undefined;
  usage: UsageTotals;
  toolNames: string[];
  /** The vendor call id (WebRTC) — the sideband hook, surfaced first-class. */
  callId?: string;
  /** Autoplay blocked the reply element; a user gesture is the remedy. */
  playbackBlocked: boolean;
}

export interface OracleSessionOptions {
  config: OracleConfig;
  keySource: KeySource;
  transport: OracleTransport;
  /** Reuse an element for reply audio (widgets pass theirs). */
  audioElement?: HTMLAudioElement;
  now?: () => number;
}

interface PendingFunctionCall {
  callId: string;
  name: string;
  args: string;
}

export class OracleSession {
  readonly transport: OracleTransport;

  private readonly options: OracleSessionOptions;
  private readonly now: () => number;
  private readonly entries: LedgerEntry[] = [];
  private readonly ledgerListeners = new Set<(entry: LedgerEntry) => void>();
  private readonly stateListeners = new Set<(state: OracleState) => void>();
  private readonly pendingUpdates: Array<Record<string, unknown>> = [];
  /** `function_call_arguments.done` stamps, per call_id — the gate's cost
   * (args-ready → response.done) is measured, not argued about. */
  private readonly argsDoneAt = new Map<string, number>();
  private toolsByName = new Map<string, OracleTool>();
  private handle: TransportHandle | undefined;
  private seq = 0;
  private eventSeq = 0;
  private current: OracleState = {
    status: "idle",
    speaking: false,
    replying: false,
    replyText: "",
    usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, responses: 0 },
    toolNames: [],
    playbackBlocked: false,
  };

  constructor(options: OracleSessionOptions) {
    this.options = options;
    this.transport = options.transport;
    this.now = options.now ?? (() => Date.now());
    this.applyTools(options.config.tools ?? []);
  }

  // ── observation ────────────────────────────────────────────────────────────

  state(): OracleState {
    return { ...this.current, usage: { ...this.current.usage } };
  }

  ledger(): readonly LedgerEntry[] {
    return this.entries;
  }

  onLedger(listener: (entry: LedgerEntry) => void): () => void {
    this.ledgerListeners.add(listener);
    return () => this.ledgerListeners.delete(listener);
  }

  onState(listener: (state: OracleState) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.current.status !== "idle" && this.current.status !== "closed") {
      return;
    }
    // `replyText` resets HERE, not on close: a new connection is a new
    // conversation (the vendor carries no history across sessions), and a
    // session object is REUSED across connects by hosts that hold one for the
    // page's lifetime — the intent panel does. Without this, a reconnect would
    // open showing the last session's reply, and "ready — talk to it" (the
    // once-per-session invitation the strip no longer returns to) would never
    // appear again.
    this.setState({ status: "connecting", playbackBlocked: false, replyText: "" });
    this.record({
      kind: "session",
      phase: "connecting",
      detail: `${this.transport.name} · ${this.options.keySource.describe()}`,
    });
    const session = this.wireSession();
    let credential: Awaited<ReturnType<KeySource["credential"]>>;
    try {
      credential = await this.options.keySource.credential(session);
    } catch (error) {
      this.fail("key", error);
      return;
    }
    try {
      this.handle = await this.transport.connect({
        credential,
        session,
        onEvent: (event) => this.onVendorEvent(event),
        onClose: (reason) => this.onTransportClose(reason),
        onPlaybackBlocked: () => this.setState({ playbackBlocked: true }),
        ...(this.options.audioElement !== undefined
          ? { audioElement: this.options.audioElement }
          : {}),
      });
    } catch (error) {
      this.fail("transport", error);
      return;
    }
    // The opening update re-asserts everything a session.update MAY carry
    // (never voice/model). Redundant when the mint baked the same config —
    // and exactly what makes a pasted foreign `ek_` (unknown baked config)
    // behave identically.
    this.sendSessionUpdate(this.updatableSession());
    const callId = this.handle.callId;
    this.setState({ status: "live", ...(callId !== undefined ? { callId } : {}) });
    const liveBits = [
      ...(callId !== undefined ? [`call ${callId}`] : []),
      ...(credential.source !== undefined ? [`key: ${credential.source}`] : []),
      // The mic's EFFECTIVE processing, recorded where it survives the
      // session: a reply that keeps interrupting itself is echo, and the one
      // fact that settles it is whether the browser really granted echo
      // cancellation — which cannot be asked after the session has closed.
      ...describeAudio(this.handle.audioSettings?.()),
    ];
    this.record({
      kind: "session",
      phase: "live",
      ...(liveBits.length > 0 ? { detail: liveBits.join(" · ") } : {}),
    });
  }

  /** Gate the mic, keep the connection: the free park. */
  park(): void {
    if (this.current.status !== "live" || this.handle === undefined) {
      return;
    }
    this.handle.setMicEnabled(false);
    this.setState({ status: "parked", speaking: false });
    this.record({ kind: "session", phase: "parked" });
  }

  resume(): void {
    if (this.current.status !== "parked" || this.handle === undefined) {
      return;
    }
    this.handle.setMicEnabled(true);
    this.setState({ status: "live" });
    this.record({ kind: "session", phase: "live", detail: "resumed" });
  }

  /** Manual barge-in — safe to fire with no reply in flight. */
  stopSpeaking(): void {
    this.handle?.interrupt();
  }

  close(): void {
    if (this.handle === undefined) {
      this.setState({ status: "closed" });
      return;
    }
    this.handle.close();
    this.handle = undefined;
    this.setState({ status: "closed", speaking: false, replying: false });
    this.record({ kind: "session", phase: "closed" });
  }

  micStream(): MediaStream | undefined {
    return this.handle?.micStream;
  }

  // ── the live surface (owner decision: flexible day one) ────────────────────

  /** Replace the tool surface mid-session (wholesale — the vendor semantics).
   * Reconciled against the `session.updated` ack; drift lands in the ledger. */
  setTools(tools: OracleTool[]): void {
    this.applyTools(tools);
    if (this.handle !== undefined) {
      this.sendSessionUpdate({ tools: this.toolSchemas() });
    }
  }

  setInstructions(instructions: string): void {
    this.options.config.instructions = instructions;
    if (this.handle !== undefined) {
      this.sendSessionUpdate({ instructions });
    }
  }

  /** Every session.update goes through here: GA requires the `type`
   * discriminator on the session object — omitting it is rejected with
   * "Missing required parameter: 'session.type'" (found live at first
   * light; masked on connect because the mint had baked the same config). */
  private sendSessionUpdate(session: Record<string, unknown>): void {
    const typed = { type: "realtime", ...session };
    this.send({ type: "session.update", session: typed });
    this.pendingUpdates.push(typed);
  }

  // ── rich input (ad-hoc text and images ride the same conversation) ─────────

  sendText(text: string, options: { respond?: boolean; role?: "user" | "system" } = {}): void {
    if (this.handle === undefined || text === "") {
      return;
    }
    const role = options.role ?? "user";
    this.send({
      type: "conversation.item.create",
      item: {
        type: "message",
        role,
        content: [{ type: "input_text", text }],
      },
    });
    if (options.respond !== false && role === "user") {
      this.send({ type: "response.create" });
    }
    this.record({ kind: "injected", role, text });
  }

  /**
   * `image` is a data URL or fully-qualified URL (the vendor's contract).
   *
   * `respond` defaults to true — pasting an image into a lab bench is a
   * question. Pass `false` when the image is CONTEXT the human is about to
   * talk about: the intent panel's oracle does, because a shot taken
   * mid-sentence must not make the model start answering over them (owner,
   * 2026-07-30 — the same rule `sendText` already carries).
   */
  sendImage(image: string, caption?: string, options: { respond?: boolean } = {}): void {
    if (this.handle === undefined) {
      return;
    }
    this.send({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [
          ...(caption !== undefined ? [{ type: "input_text", text: caption }] : []),
          { type: "input_image", image_url: image },
        ],
      },
    });
    if (options.respond !== false) {
      this.send({ type: "response.create" });
    }
    this.record({
      kind: "injected",
      role: "user",
      ...(caption !== undefined ? { text: caption } : {}),
      image: true,
    });
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private applyTools(tools: OracleTool[]): void {
    this.toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
    this.setState({ toolNames: tools.map((tool) => tool.name) });
  }

  private toolSchemas(): Array<Record<string, unknown>> {
    return [...this.toolsByName.values()].map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
  }

  /** The full wire config, baked at mint time (a default, not a sandbox). */
  private wireSession(): Record<string, unknown> {
    const config = this.options.config;
    return {
      type: "realtime",
      model: config.model ?? DEFAULT_ORACLE_MODEL,
      audio: {
        output: { voice: config.voice ?? DEFAULT_ORACLE_VOICE },
      },
      ...this.updatableSession(),
    };
  }

  /** The session.update-safe subset — everything EXCEPT voice and model. */
  private updatableSession(): Record<string, unknown> {
    const config = this.options.config;
    const turn = config.turn ?? "auto";
    return {
      instructions: config.instructions,
      audio: {
        input: {
          turn_detection:
            turn === "manual"
              ? null
              : {
                  type: turn === "semantic" ? "semantic_vad" : "server_vad",
                  // The vendor's own tuning, passed through verbatim. Verified
                  // by the `session.updated` echo the config ledger records —
                  // never assumed to have been accepted.
                  ...(config.turnTuning ?? {}),
                },
          ...(config.transcribeInput !== false
            ? { transcription: { model: DEFAULT_INPUT_TRANSCRIPTION_MODEL } }
            : {}),
        },
      },
      tools: this.toolSchemas(),
    };
  }

  private send(event: Record<string, unknown>): void {
    this.handle?.send({ event_id: `evt_${++this.eventSeq}`, ...event });
  }

  private onVendorEvent(event: Record<string, unknown>): void {
    const type = typeof event.type === "string" ? event.type : "";
    switch (type) {
      case "session.created":
        return;
      case "session.updated": {
        const sent = this.pendingUpdates.shift();
        const effective = (event.session ?? {}) as Record<string, unknown>;
        this.record({
          kind: "config",
          ...(sent !== undefined ? { sent } : {}),
          effective,
          ...(sent !== undefined ? { drift: configDrift(sent, effective) } : {}),
        });
        return;
      }
      case "input_audio_buffer.speech_started":
        this.setState({ speaking: true });
        this.record({ kind: "speech", phase: "started" });
        return;
      case "input_audio_buffer.speech_stopped":
        this.setState({ speaking: false });
        this.record({ kind: "speech", phase: "stopped" });
        return;
      case "conversation.item.input_audio_transcription.completed": {
        const text = typeof event.transcript === "string" ? event.transcript.trim() : "";
        if (text !== "") {
          this.record({ kind: "heard", text });
        }
        return;
      }
      case "conversation.item.input_audio_transcription.failed": {
        const error = (event.error ?? {}) as Record<string, unknown>;
        this.record({
          kind: "error",
          source: "vendor",
          message: `input transcription failed: ${typeof error.message === "string" ? error.message : "?"}`,
          data: error,
        });
        return;
      }
      case "response.created":
        this.setState({ replying: true, replyText: "" });
        return;
      case "response.output_audio_transcript.delta": {
        const delta = typeof event.delta === "string" ? event.delta : "";
        this.setState({ replyText: this.current.replyText + delta });
        return;
      }
      case "response.output_audio_transcript.done": {
        const text = typeof event.transcript === "string" ? event.transcript : "";
        const responseId = typeof event.response_id === "string" ? event.response_id : "";
        if (text !== "") {
          this.record({ kind: "said", responseId, text });
        }
        return;
      }
      case "response.done":
        this.onResponseDone((event.response ?? {}) as Record<string, unknown>);
        return;
      case "error": {
        const error = (event.error ?? event) as Record<string, unknown>;
        this.record({
          kind: "error",
          source: "vendor",
          message: typeof error.message === "string" ? error.message : "vendor error",
          data: error,
        });
        return;
      }
      case "response.function_call_arguments.done": {
        // Not permission to execute (it fires for cancelled responses too) —
        // but it IS the moment the arguments were ready, so stamp it: the
        // tool-call entry's gateMs is the measured cost of waiting for
        // response.done.
        if (typeof event.call_id === "string") {
          this.argsDoneAt.set(event.call_id, this.now());
        }
        return;
      }
      // Known chatter the ledger doesn't need: streaming deltas whose final
      // form is recorded elsewhere (heard/said), per-item adds the
      // response.done path covers, and buffer bookkeeping. Everything NOT
      // named here still lands as `raw` — the list is allow-to-drop, and it
      // was grown from a real first-light transcript, not guessed.
      case "response.function_call_arguments.delta":
      case "response.output_audio_transcript.started":
      case "conversation.item.input_audio_transcription.delta":
      case "conversation.item.input_audio_transcription.segment":
      case "conversation.item.added":
      case "conversation.item.done":
      case "response.output_item.added":
      case "response.output_item.done":
      case "response.content_part.added":
      case "response.content_part.done":
      case "response.output_audio.delta":
      case "response.output_audio.done":
      case "input_audio_buffer.committed":
      case "input_audio_buffer.cleared":
      case "output_audio_buffer.started":
      case "output_audio_buffer.stopped":
      case "output_audio_buffer.cleared":
      case "rate_limits.updated":
        return;
      default:
        this.record({ kind: "raw", type: type === "" ? "(untyped)" : type, event });
        return;
    }
  }

  private onResponseDone(response: Record<string, unknown>): void {
    const responseId = typeof response.id === "string" ? response.id : "";
    const status = typeof response.status === "string" ? response.status : "unknown";
    const usage = tallyUsage(response.usage);
    if (usage !== undefined) {
      this.setState({
        usage: {
          inputTokens: this.current.usage.inputTokens + usage.inputTokens,
          cachedInputTokens: this.current.usage.cachedInputTokens + usage.cachedInputTokens,
          outputTokens: this.current.usage.outputTokens + usage.outputTokens,
          responses: this.current.usage.responses + 1,
        },
      });
    }
    this.setState({ replying: false });
    this.record({
      kind: "response",
      responseId,
      status,
      ...(usage !== undefined ? { usage } : {}),
    });

    const calls: PendingFunctionCall[] = [];
    const output = Array.isArray(response.output) ? response.output : [];
    for (const item of output as Array<Record<string, unknown>>) {
      if (item.type === "function_call") {
        const call: PendingFunctionCall = {
          callId: typeof item.call_id === "string" ? item.call_id : "",
          name: typeof item.name === "string" ? item.name : "",
          args: typeof item.arguments === "string" ? item.arguments : "",
        };
        const argsAt = this.argsDoneAt.get(call.callId);
        this.argsDoneAt.delete(call.callId);
        this.record({
          kind: "tool-call",
          callId: call.callId,
          name: call.name,
          args: call.args,
          status:
            status === "completed"
              ? "completed"
              : status === "cancelled"
                ? "cancelled"
                : "incomplete",
          ...(argsAt !== undefined ? { gateMs: this.now() - argsAt } : {}),
        });
        if (status === "completed") {
          calls.push(call);
        }
      }
    }
    if (calls.length > 0) {
      void this.runToolCalls(calls);
    }
  }

  /** Execute gated calls, return every output, then solicit ONE response. */
  private async runToolCalls(calls: PendingFunctionCall[]): Promise<void> {
    for (const call of calls) {
      const started = this.now();
      this.setState({ runningTool: call.name });
      const { ok, output } = await this.runOneTool(call);
      this.record({
        kind: "tool-result",
        callId: call.callId,
        name: call.name,
        ok,
        output,
        ms: this.now() - started,
      });
      this.send({
        type: "conversation.item.create",
        item: { type: "function_call_output", call_id: call.callId, output },
      });
    }
    this.setState({ runningTool: undefined });
    this.send({ type: "response.create" });
  }

  private async runOneTool(call: PendingFunctionCall): Promise<{ ok: boolean; output: string }> {
    const tool = this.toolsByName.get(call.name);
    if (tool === undefined) {
      return { ok: false, output: JSON.stringify({ error: `unknown tool: ${call.name}` }) };
    }
    let args: Record<string, unknown>;
    try {
      const parsed: unknown = call.args === "" ? {} : JSON.parse(call.args);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("arguments are not an object");
      }
      args = parsed as Record<string, unknown>;
    } catch (error) {
      // No strict mode exists for realtime tools — malformed arguments are an
      // expected case, answered in-band (the vendor has no tool error channel).
      return {
        ok: false,
        output: JSON.stringify({ error: `invalid arguments: ${message(error)}` }),
      };
    }
    try {
      const result = await tool.execute(args);
      return { ok: true, output: JSON.stringify(result === undefined ? null : result) };
    } catch (error) {
      this.record({ kind: "error", source: "tool", message: `${call.name}: ${message(error)}` });
      return { ok: false, output: JSON.stringify({ error: message(error) }) };
    }
  }

  private onTransportClose(reason: string): void {
    if (this.current.status === "closed" || this.current.status === "error") {
      return;
    }
    this.handle = undefined;
    this.setState({ status: "closed", speaking: false, replying: false });
    this.record({ kind: "session", phase: "closed", detail: reason });
  }

  private fail(source: "key" | "transport", error: unknown): void {
    this.setState({ status: "error" });
    this.record({ kind: "error", source, message: message(error) });
    this.record({ kind: "session", phase: "error", detail: message(error) });
  }

  private setState(patch: Partial<OracleState>): void {
    this.current = { ...this.current, ...patch };
    for (const listener of this.stateListeners) {
      listener(this.state());
    }
  }

  private record(entry: LedgerBody): void {
    const full: LedgerEntry = { at: this.now(), seq: ++this.seq, ...entry };
    this.entries.push(full);
    for (const listener of this.ledgerListeners) {
      listener(full);
    }
  }
}

/**
 * The mic's processing as one readable phrase — `mic: aec+ns+agc` when the
 * browser honored all three, and conspicuously shorter when it did not.
 * Empty when the transport reports nothing (a fake, a WS handle).
 */
function describeAudio(settings: Record<string, unknown> | undefined): string[] {
  if (settings === undefined) {
    return [];
  }
  const on: string[] = [];
  if (settings.echoCancellation === true) on.push("aec");
  if (settings.noiseSuppression === true) on.push("ns");
  if (settings.autoGainControl === true) on.push("agc");
  return [`mic: ${on.length > 0 ? on.join("+") : "NO PROCESSING"}`];
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Name the gaps between what we asked for and what the server holds. */
function configDrift(sent: Record<string, unknown>, effective: Record<string, unknown>): string[] {
  const drift: string[] = [];
  if (Array.isArray(sent.tools)) {
    const wanted = new Set(
      (sent.tools as Array<Record<string, unknown>>).map((tool) => String(tool.name)),
    );
    const held = new Set(
      (Array.isArray(effective.tools) ? (effective.tools as Array<Record<string, unknown>>) : [])
        .filter((tool) => tool.type === "function")
        .map((tool) => String(tool.name)),
    );
    for (const name of wanted) {
      if (!held.has(name)) {
        drift.push(`tool not held: ${name}`);
      }
    }
    for (const name of held) {
      if (!wanted.has(name)) {
        drift.push(`unexpected tool held: ${name}`);
      }
    }
  }
  if (typeof sent.instructions === "string" && typeof effective.instructions === "string") {
    if (sent.instructions !== effective.instructions) {
      drift.push("instructions differ from intended");
    }
  }
  return drift;
}

function tallyUsage(usage: unknown): UsageTotals | undefined {
  if (usage === null || typeof usage !== "object") {
    return undefined;
  }
  const u = usage as Record<string, unknown>;
  const details = (u.input_token_details ?? {}) as Record<string, unknown>;
  return {
    inputTokens: numberOr0(u.input_tokens),
    cachedInputTokens: numberOr0(details.cached_tokens),
    outputTokens: numberOr0(u.output_tokens),
    responses: 1,
  };
}

function numberOr0(value: unknown): number {
  return typeof value === "number" ? value : 0;
}
