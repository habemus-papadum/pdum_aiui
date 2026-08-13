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

import { priceRealtimeUsage, usageFromRealtimeResponse } from "./cost";
import { pruneTurnDetection, setPath, TURN_DETECTION_TYPE } from "./params";
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
  DEFAULT_FIRST_REPLY_MAX_MS,
  DEFAULT_FIRST_REPLY_PAD_MS,
  DEFAULT_INPUT_TRANSCRIPTION_MODEL,
  DEFAULT_ORACLE_MODEL,
  DEFAULT_ORACLE_VOICE,
  DEFAULT_PARK_AFTER_IDLE_SECONDS,
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
  /** Why the session is parked — the banner says "you did this" or "you left
   * it", which are different things to a human coming back to it. */
  parkedReason?: "manual" | "idle" | undefined;
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
  /** The first-reply echo window, while it is OPEN — `undefined` once
   * interrupts are armed (or when the guard is off). Read by
   * {@link audioSession}, which is what makes the window a property of the
   * config we send rather than a flag anyone has to remember to apply. */
  private guard: { padMs: number; maxMs: number } | undefined;
  /** Whether THIS connection ever had the window open — what obligates the
   * explicit restore of the suppressed fields on every send after arming
   * (a value we once sent `false` must be re-stated, not omitted). */
  private guardWasOpen = false;
  private guardTimer: ReturnType<typeof setTimeout> | undefined;
  /** The unattended-session stopwatch — restarted by every activity entry. */
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  /** Whether the current reply ever produced audio — a reply that did not
   * (a tool-only turn) has no end-of-speech event to wait for. */
  private replyAudioStarted = false;
  /** The last `session.updated` payload — what the server says it holds. */
  private lastEffective: Record<string, unknown> | undefined;
  private seq = 0;
  private eventSeq = 0;
  private current: OracleState = {
    status: "idle",
    speaking: false,
    replying: false,
    replyText: "",
    usage: EMPTY_USAGE,
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
    // The echo window opens BEFORE the config is built: `audioSession` reads
    // `this.guard`, so the baked session and the opening update carry the
    // suppressed interrupt from the very first byte. A reconnect re-opens it —
    // a new peer connection is a new echo canceller, with nothing learned.
    this.openGuard();
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
    // The greeting — echo-canceller priming (see OracleConfig.greeting). Sent
    // AFTER the opening update so the window's suppressions are in force
    // before the model speaks; the explicit create is also what makes those
    // suppressions safe (the window's exit is this very reply).
    const greeting = this.greetingText();
    if (greeting !== undefined) {
      this.record({ kind: "sent", type: "greeting" });
      this.send({
        type: "response.create",
        response: {
          instructions: `Open the conversation by saying exactly: "${greeting}". Say nothing else.`,
        },
      });
    }
    // Connecting is not activity, but it IS the moment the mic opens — so the
    // stopwatch starts here. A session opened and then abandoned before a word
    // is said is the same hazard as one abandoned mid-conversation.
    this.touchIdle();
  }

  /** Gate the mic, keep the connection: the free park. */
  park(reason: "manual" | "idle" = "manual"): void {
    if (this.current.status !== "live" || this.handle === undefined) {
      return;
    }
    this.clearIdleTimer();
    this.handle.setMicEnabled(false);
    this.setState({ status: "parked", speaking: false, parkedReason: reason });
    this.record({
      kind: "session",
      phase: "parked",
      ...(reason === "idle"
        ? { detail: `idle ${this.parkAfterIdleSeconds()}s — mic gated, session kept` }
        : {}),
    });
  }

  resume(): void {
    if (this.current.status !== "parked" || this.handle === undefined) {
      return;
    }
    this.handle.setMicEnabled(true);
    this.setState({ status: "live", parkedReason: undefined });
    this.record({ kind: "session", phase: "live", detail: "resumed" });
    // A resume IS activity — otherwise an unpark with nothing said after it
    // would re-park against a stopwatch that never restarted.
    this.touchIdle();
  }

  /** Manual barge-in — safe to fire with no reply in flight. */
  stopSpeaking(): void {
    if (this.handle === undefined) {
      return;
    }
    // Recorded HERE because the transport owns the wire shape of an interrupt
    // (WebRTC sends `response.cancel` + `output_audio_buffer.clear`; another
    // transport may differ), so `send` never sees it. Without this line a
    // deliberate shush and a vendor barge-in are indistinguishable in the
    // record — which is exactly the question the ledger has to answer.
    this.record({ kind: "sent", type: "interrupt (shush)" });
    this.handle.interrupt();
  }

  close(): void {
    this.clearGuardTimer();
    this.clearIdleTimer();
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

  /**
   * Set one session parameter by its VENDOR path — `"audio.input
   * .turn_detection.silence_duration_ms"`, `"audio.output.speed"` — and
   * re-send. `undefined` deletes the key (back to the vendor's default);
   * `null` is a value in its own right (`turn_detection: null` is manual).
   *
   * What goes on the wire is the whole updatable session, not the field that
   * changed. `turn_detection` travels as a complete object with no documented
   * field-level patch, so whether the vendor merges INSIDE it is unverified —
   * and if it replaces, a lone `{ silence_duration_ms }` would silently drop
   * `type` and `threshold` back to defaults, undoing tuning while appearing
   * to work. A whole-session send is correct under either semantics, and it
   * means the `config` entry's drift covers everything rather than the one
   * block someone remembered to include.
   *
   * Switching `turn_detection.type` drops the outgoing algorithm's knobs,
   * because they do not exist on the other side: `threshold` is meaningless
   * to `semantic_vad` and `eagerness` to `server_vad`.
   */
  setSessionParam(path: string, value: unknown): void {
    const config = this.options.config as unknown as Record<string, unknown>;
    if (path === TURN_DETECTION_TYPE) {
      setPath(config, path, value);
      pruneTurnDetection(this.options.config);
    } else {
      setPath(config, path, value);
    }
    if (this.handle !== undefined) {
      this.sendSessionUpdate(this.updatableSession());
    }
  }

  /**
   * What we INTEND the server to hold, as the vendor's session shape —
   * INCLUDING the frozen fields (`model`, `voice`), which a params widget must
   * still be able to display even though no update may carry them. Paired with
   * {@link effectiveSession} this is the whole sent-vs-in-force story.
   */
  sessionConfig(): Record<string, unknown> {
    return this.wireSession();
  }

  /** What the server said it holds, from the last `session.updated`.
   * Undefined until the first ack — which is itself worth showing. */
  effectiveSession(): Record<string, unknown> | undefined {
    return this.lastEffective;
  }

  // ── the mic track (the WebRTC half of the same discipline) ─────────────────

  /** Apply constraints to the LIVE mic track. Resolves if the browser took
   * them; rejects otherwise — and {@link audioSettings} is what says which,
   * since a browser may resolve and still not have changed anything. */
  async applyAudioConstraints(constraints: MediaTrackConstraints): Promise<void> {
    const apply = this.handle?.applyAudioConstraints;
    if (apply === undefined) {
      throw new Error("this transport has no local mic track");
    }
    await apply(constraints);
    this.record({ kind: "sent", type: `applyConstraints ${JSON.stringify(constraints)}` });
  }

  /** The mic track's EFFECTIVE settings right now — the readback half. */
  audioSettings(): Record<string, unknown> | undefined {
    return this.handle?.audioSettings?.();
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

  /** The full wire config, baked at mint time (a default, not a sandbox).
   * `model` and `voice` ride ONLY here — both are frozen fields a
   * `session.update` may not carry. */
  private wireSession(): Record<string, unknown> {
    const config = this.options.config;
    const updatable = this.updatableSession();
    const audio = updatable.audio as Record<string, unknown>;
    return {
      ...updatable,
      type: "realtime",
      model: config.model ?? DEFAULT_ORACLE_MODEL,
      audio: {
        ...audio,
        output: {
          ...(audio.output as Record<string, unknown> | undefined),
          voice: config.audio?.output?.voice ?? DEFAULT_ORACLE_VOICE,
        },
      },
    };
  }

  /** The session.update-safe subset — everything EXCEPT voice and model. */
  private updatableSession(): Record<string, unknown> {
    const config = this.options.config;
    return {
      instructions: config.instructions,
      ...this.audioSession(),
      tools: this.toolSchemas(),
      ...(config.max_output_tokens !== undefined
        ? { max_output_tokens: config.max_output_tokens }
        : {}),
    };
  }

  /**
   * The COMPLETE `audio.input` block, always built whole.
   *
   * Its parts are siblings that must travel together: `noise_reduction` sits
   * beside `turn_detection`, not inside it, and the guard's suppression sits
   * inside `turn_detection` beside the tuning. Since nested merge semantics
   * are unverified (see {@link setTurnTuning}), every send of this block is a
   * full statement of intent rather than a patch — which also means a drift
   * check against the ack covers the whole thing.
   */
  private audioSession(): Record<string, unknown> {
    const input = this.options.config.audio?.input ?? {};
    const output = this.options.config.audio?.output ?? {};
    // `turn_detection` defaults to server_vad at the vendor's own settings;
    // an explicit `null` means no turn detection, and must survive as null
    // rather than being read as "unset".
    const configured: Partial<NonNullable<typeof input.turn_detection>> =
      input.turn_detection ?? {};
    const turnDetection =
      input.turn_detection === null
        ? null
        : {
            type: "server_vad",
            ...configured,
            // …and the echo window wins over the configured values while
            // open: the first reply may not be truncated by what the mic
            // hears. Arming re-sends this block without the suppression.
            //
            // ONLY the interrupt — unless a greeting is configured.
            // `create_response: false` alone rode here for one commit and
            // deadlocked the session mute: the window closes when a reply
            // happens, and suppressing response CREATION means the human's
            // first utterance never makes one — so `response.created` never
            // fires, the cap never starts, and nothing can ever close the
            // window. Every exit hangs off a response that cannot exist.
            // Without a greeting, the echo committing itself as a user turn
            // is the lesser evil. WITH one, the first reply is created
            // explicitly by us (see start), so the exit no longer depends on
            // the VAD being allowed to create it — and the suppression stops
            // the greeting's own echo from being answered.
            ...(this.guard !== undefined
              ? {
                  interrupt_response: false,
                  ...(this.greetingText() !== undefined ? { create_response: false } : {}),
                }
              : this.guardWasOpen
                ? {
                    // Closing the window restores the suppressed fields
                    // EXPLICITLY, never by omission. Nested merge semantics
                    // are unverified (see setSessionParam) — and under merge
                    // an omitted key keeps its last sent value. Found live
                    // 2026-08-13: the armed update omitted create_response,
                    // the server kept `false`, and no utterance was ever
                    // answered again. Explicit values are correct under
                    // either semantics, and the drift check then covers the
                    // restore like any other field.
                    interrupt_response: configured.interrupt_response ?? true,
                    ...(this.greetingText() !== undefined
                      ? { create_response: configured.create_response ?? true }
                      : {}),
                  }
                : {}),
          };
    return {
      audio: {
        input: {
          turn_detection: turnDetection,
          transcription:
            input.transcription === undefined
              ? { model: DEFAULT_INPUT_TRANSCRIPTION_MODEL }
              : input.transcription,
          ...(input.noise_reduction !== undefined
            ? { noise_reduction: input.noise_reduction }
            : {}),
        },
        ...(output.speed !== undefined ? { output: { speed: output.speed } } : {}),
      },
    };
  }

  /** The greeting, or undefined when there is none (empty string counts as
   * none — a session cannot speak nothing). */
  private greetingText(): string | undefined {
    const greeting = this.options.config.greeting;
    return greeting === undefined || greeting === "" ? undefined : greeting;
  }

  // ── the first-reply echo window ────────────────────────────────────────────

  /** Open the window, if the config wants one and there is a VAD to suppress
   * (manual turn control has no `turn_detection` object to carry it). */
  private openGuard(): void {
    this.clearGuardTimer();
    this.replyAudioStarted = false;
    this.guardWasOpen = false;
    const wanted = this.options.config.firstReplyGuard ?? true;
    // No `turn_detection` object means no `interrupt_response` to suppress.
    if (wanted === false || this.options.config.audio?.input?.turn_detection === null) {
      this.guard = undefined;
      return;
    }
    const tuning = wanted === true ? {} : wanted;
    this.guard = {
      padMs: tuning.padMs ?? DEFAULT_FIRST_REPLY_PAD_MS,
      maxMs: tuning.maxMs ?? DEFAULT_FIRST_REPLY_MAX_MS,
    };
    this.guardWasOpen = true;
  }

  /** Close the window: re-send the audio block with the configured values. */
  private armInterrupts(reason: string): void {
    if (this.guard === undefined) {
      return;
    }
    this.guard = undefined;
    this.clearGuardTimer();
    if (this.handle === undefined) {
      return;
    }
    // A `sent` line, because arming is OURS and the ledger's job here is
    // attribution: a barge-in after this point is the vendor's doing, and the
    // record has to show when that became possible.
    this.record({ kind: "sent", type: `interrupts armed (${reason})` });
    this.sendSessionUpdate(this.audioSession());
  }

  private armLater(ms: number, reason: string): void {
    this.clearGuardTimer();
    this.guardTimer = setTimeout(() => {
      this.guardTimer = undefined;
      this.armInterrupts(reason);
    }, ms);
  }

  private clearGuardTimer(): void {
    if (this.guardTimer !== undefined) {
      clearTimeout(this.guardTimer);
      this.guardTimer = undefined;
    }
  }

  // ── the unattended session ────────────────────────────────────────────────

  /**
   * Ledger kinds that count as ACTIVITY.
   *
   * Named explicitly rather than derived from the viewer's categories: the
   * engine must not depend on a widget's presentation choices, and the list
   * is a behavioural decision worth reading in one place. What is absent
   * matters most — `session` and `config` entries are bookkeeping that ticks
   * along on its own, and counting them would keep an abandoned session awake
   * forever, which is exactly the state this exists to end.
   */
  private static readonly ACTIVITY = new Set<LedgerBody["kind"]>([
    "speech",
    "heard",
    "said",
    "reply-audio",
    "tool-call",
    "tool-result",
    "injected",
    "response",
  ]);

  private parkAfterIdleSeconds(): number {
    return this.options.config.parkAfterIdleSeconds ?? DEFAULT_PARK_AFTER_IDLE_SECONDS;
  }

  /** Restart the stopwatch. Only a LIVE session can go idle — a parked one is
   * already where the timer would send it, and a closed one has nothing to
   * gate. */
  private touchIdle(): void {
    this.clearIdleTimer();
    const seconds = this.parkAfterIdleSeconds();
    if (seconds <= 0 || this.current.status !== "live") {
      return;
    }
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      this.park("idle");
    }, seconds * 1000);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== undefined) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  /** The aiui-side knobs — ours, not the vendor's, and applied immediately
   * rather than sent anywhere (there is nothing on the wire to send). */
  behavior(): { parkAfterIdleSeconds: number } {
    return { parkAfterIdleSeconds: this.parkAfterIdleSeconds() };
  }

  setBehavior(path: string, value: unknown): void {
    setPath(this.options.config as unknown as Record<string, unknown>, path, value);
    // Take effect NOW, not on the next activity: shortening the timeout while
    // an idle session sits there should park it, not wait for something to
    // happen first — which by definition is not going to.
    this.touchIdle();
  }

  /** Outbound control events worth a ledger line — the ones that can move a
   * response's lifecycle, and therefore the ones a cancellation has to be
   * attributable against. */
  private static readonly TRACED_SENDS = new Set(["response.create", "response.cancel"]);

  private send(event: Record<string, unknown>): void {
    const type = typeof event.type === "string" ? event.type : "";
    if (OracleSession.TRACED_SENDS.has(type)) {
      this.record({ kind: "sent", type });
    }
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
        this.lastEffective = effective;
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
        this.replyAudioStarted = false;
        // The cap starts counting at the FIRST response, not at connect: an
        // idle session has no echo to guard against. `guardTimer === undefined`
        // is the "first" test — once armed or scheduled, this leaves it alone.
        if (this.guard !== undefined && this.guardTimer === undefined) {
          this.armLater(this.guard.maxMs, "timeout");
        }
        return;
      // The reply's own audio lifecycle — WebRTC-only, undocumented, and the
      // only honest answer to "has it stopped talking?". Recorded, and the
      // hinge the echo window turns on.
      case "output_audio_buffer.started":
        this.replyAudioStarted = true;
        this.record({ kind: "reply-audio", phase: "started" });
        return;
      case "output_audio_buffer.stopped":
      case "output_audio_buffer.cleared": {
        const phase = type === "output_audio_buffer.stopped" ? "stopped" : "cleared";
        this.record({ kind: "reply-audio", phase });
        if (this.guard !== undefined) {
          // Not immediately: `stopped` says the SERVER finished sending, and
          // the client still has a jitter buffer's worth of speech to play.
          this.armLater(this.guard.padMs, `reply audio ${phase}`);
        }
        return;
      }
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
    const usage = tallyUsage(response.usage, this.options.config.model ?? DEFAULT_ORACLE_MODEL);
    if (usage !== undefined) {
      this.setState({ usage: addUsage(this.current.usage, usage) });
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
    // A response that never spoke leaves no end-of-audio event to wait for and
    // poses no echo risk, so close the window rather than burn the cap on it.
    // But NOT when tool calls follow: that response is about to be answered by
    // a spoken one, and arming here would disarm the guard immediately before
    // the first words the session ever says — the exact hazard, one turn later.
    // Spoken responses never reach this test; `output_audio_buffer.started`
    // arrives well before `response.done` (and `stopped` after it).
    if (!this.replyAudioStarted && calls.length === 0) {
      this.armInterrupts("no reply audio");
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
    this.clearGuardTimer();
    this.clearIdleTimer();
    if (this.current.status === "closed" || this.current.status === "error") {
      return;
    }
    this.handle = undefined;
    this.setState({ status: "closed", speaking: false, replying: false });
    this.record({ kind: "session", phase: "closed", detail: reason });
  }

  private fail(source: "key" | "transport", error: unknown): void {
    this.clearIdleTimer();
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
    // The stopwatch hangs off the LEDGER rather than off the vendor event
    // stream, so anything that counts as having happened resets it exactly
    // once, by construction — including things with no vendor event at all,
    // like an injected screenshot.
    if (OracleSession.ACTIVITY.has(entry.kind)) {
      this.touchIdle();
    }
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
  // The AUDIO INPUT block — turn detection and noise reduction. These are the
  // knobs a self-interrupting session is tuned with, and "we set threshold
  // 0.75" is worth nothing unless the server agrees it holds 0.75. Compared
  // field by field so a name the vendor does not know shows up as drift
  // rather than as a silently ignored setting (the house rule: send it, then
  // read the echo).
  const sentInput = audioInput(sent);
  const heldInput = audioInput(effective);
  for (const block of ["turn_detection", "noise_reduction"] as const) {
    const want = sentInput[block];
    if (want === null || typeof want !== "object") {
      continue;
    }
    const held = heldInput[block];
    if (held === null || typeof held !== "object") {
      drift.push(`${block} not held`);
      continue;
    }
    for (const [key, value] of Object.entries(want as Record<string, unknown>)) {
      const got = (held as Record<string, unknown>)[key];
      if (got !== value) {
        drift.push(`${block}.${key}: sent ${JSON.stringify(value)}, holds ${JSON.stringify(got)}`);
      }
    }
  }
  return drift;
}

/** The `audio.input` sub-object, defensively (either side may omit it). */
function audioInput(session: Record<string, unknown>): Record<string, unknown> {
  const audio = session.audio;
  if (audio === null || typeof audio !== "object") {
    return {};
  }
  const input = (audio as Record<string, unknown>).input;
  return input !== null && typeof input === "object" ? (input as Record<string, unknown>) : {};
}

/**
 * One response's usage, with the modality split kept — and priced.
 *
 * `model` decides the rate, so it is passed in rather than assumed: a session
 * may have been opened against a model the catalog does not know, and that
 * case has to stay distinguishable from "cost zero".
 */
function tallyUsage(usage: unknown, model: string): UsageTotals | undefined {
  if (usage === null || typeof usage !== "object") {
    return undefined;
  }
  const u = usage as Record<string, unknown>;
  const input = (u.input_token_details ?? {}) as Record<string, unknown>;
  const output = (u.output_token_details ?? {}) as Record<string, unknown>;
  const priceable = usageFromRealtimeResponse(u);
  const usd = priceable === undefined ? undefined : priceRealtimeUsage(model, priceable);
  return {
    inputTokens: numberOr0(u.input_tokens),
    inputAudioTokens: numberOr0(input.audio_tokens),
    cachedInputTokens: numberOr0(input.cached_tokens),
    outputTokens: numberOr0(u.output_tokens),
    outputAudioTokens: numberOr0(output.audio_tokens),
    responses: 1,
    ...(usd !== undefined ? { usd: usd.usd } : {}),
    unpricedResponses: usd === undefined ? 1 : 0,
    approximateResponses: usd?.approximate === true ? 1 : 0,
  };
}

/** A zero tally — the shape in one place, since three sites need it. */
const EMPTY_USAGE: UsageTotals = {
  inputTokens: 0,
  inputAudioTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  outputAudioTokens: 0,
  responses: 0,
  unpricedResponses: 0,
  approximateResponses: 0,
};

/** Running totals. `usd` stays ABSENT until something was priced, so "no
 * price known" and "$0.00 so far" never render as the same thing. */
function addUsage(running: UsageTotals, one: UsageTotals): UsageTotals {
  const usd =
    running.usd === undefined && one.usd === undefined
      ? undefined
      : (running.usd ?? 0) + (one.usd ?? 0);
  return {
    inputTokens: running.inputTokens + one.inputTokens,
    inputAudioTokens: running.inputAudioTokens + one.inputAudioTokens,
    cachedInputTokens: running.cachedInputTokens + one.cachedInputTokens,
    outputTokens: running.outputTokens + one.outputTokens,
    outputAudioTokens: running.outputAudioTokens + one.outputAudioTokens,
    responses: running.responses + one.responses,
    ...(usd !== undefined ? { usd } : {}),
    unpricedResponses: running.unpricedResponses + one.unpricedResponses,
    approximateResponses: running.approximateResponses + one.approximateResponses,
  };
}

function numberOr0(value: unknown): number {
  return typeof value === "number" ? value : 0;
}
