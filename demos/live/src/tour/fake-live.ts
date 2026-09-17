/**
 * fake-live.ts — a stand-in for the OpenAI side of a GPT-Live session, in
 * this tab. It speaks the same wire vocabulary the real service does
 * (`protocol.ts`), with the timings we MEASURED against the real API on
 * 2026-09-15 as its defaults, so the real `LiveSession` engine and the real
 * widgets run unchanged against it. What it cannot do: hear audio, reason,
 * or paraphrase. Its "voice model" is a script: it delegates everything but
 * greetings, speaks whatever commentary it is handed (prefixing the first
 * line of a ticket when asked to imitate the paraphrase), and runs a toy of
 * the hosted Responses loop against the session's declared tools. Nothing
 * here leaves the page.
 */

import {
  APPEND_EVENT,
  APPEND_TOKEN_LIMIT,
  APPENDED_EVENT,
  type AppendKind,
  approxTokens,
  type LiveEvent,
  type LiveTransport,
  type TransportConnectOptions,
  type TransportHandle,
} from "@habemus-papadum/aiui-live";

export interface FakeLiveKnobs {
  /** ms after the user's last word before `session.delegation.created` (measured 0.49–0.80 s). */
  delegateAfterMs: number;
  /** ms after a commentary append before its first spoken word (measured 0.52–0.67 s). */
  speakAfterMs: number;
  /** ms after an append before its `…appended` ack (measured ≈ 0.7 s). */
  ackAfterMs: number;
  /** The model's own "Okay, hang on." right after delegating (measured 0.15–0.2 s). */
  acknowledgeDelegation: boolean;
  /** Speak thinking appends too — the real model does when the prompt asks for narration. */
  narrateThinking: boolean;
  /** Imitate the paraphrase by prefixing the first spoken line of each ticket. */
  paraphrase: boolean;
  /** Transcript pace, words per second, both directions. */
  wordsPerSecond: number;
  /** Time multiplier: 1 = the measured pace; 4 = four times faster. Read at connect. */
  speed: number;
}

export const MEASURED_KNOBS: FakeLiveKnobs = {
  delegateAfterMs: 650,
  speakAfterMs: 580,
  ackAfterMs: 700,
  acknowledgeDelegation: true,
  narrateThinking: false,
  paraphrase: true,
  wordsPerSecond: 2.8,
  speed: 1,
};

export interface FakeLive {
  transport: LiveTransport;
  /** The user "speaks": transcript fragments arrive, then (unless a greeting) a delegation. */
  userSays(text: string): void;
  live(): boolean;
  /** Session-timeline ms — the clock the wire events carry. */
  clock(): number;
}

const GREETING = /^(hi|hello|hey|thanks|thank you|good (morning|afternoon|evening))\b/i;
const WORDS_PER_DELTA = 3;

interface Delegation {
  id: string;
  target: "client" | "responses";
  responseId?: string;
  request: string;
  spoke: boolean;
  pendingCall?: { callId: string; name: string; output?: unknown };
}

export function fakeLive(
  knobs: () => FakeLiveKnobs,
  onLog: (line: string) => void = () => {},
): FakeLive {
  let conn: Connection | undefined;
  const transport: LiveTransport = {
    name: "simulated",
    async connect(opts: TransportConnectOptions): Promise<TransportHandle> {
      conn?.teardown();
      const created = new Connection(opts, { ...knobs() }, onLog);
      conn = created;
      return created.handle;
    },
  };
  return {
    transport,
    userSays: (text) => conn?.userSays(text),
    live: () => conn?.open === true,
    clock: () => conn?.clock() ?? 0,
  };
}

class Connection {
  readonly handle: TransportHandle;
  open = false;
  private closed = false;
  private muted = false;
  private readonly t0 = Date.now();
  private readonly sessionId = `live_sim_${Math.random().toString(36).slice(2, 8)}`;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly delegations = new Map<string, Delegation>();
  private seq = 0;
  /** Timeline ms until which the voice model is busy speaking. */
  private speakingUntil = 0;
  private pendingTyped: string | undefined;

  constructor(
    private readonly opts: TransportConnectOptions,
    private readonly k: FakeLiveKnobs,
    private readonly log: (line: string) => void,
  ) {
    this.handle = {
      send: (event) => this.onClientEvent(event),
      setMicEnabled: (on) => {
        this.muted = !on;
      },
      close: () => this.teardown(),
      sessionId: this.sessionId,
    };
    const seeded = opts.session.input?.length ?? 0;
    // Measured: socket open → session.started in 0.5–0.9 s.
    this.after(600, () => {
      this.open = true;
      this.emit({
        type: "session.started",
        session: {
          id: this.sessionId,
          expires_at: Math.floor(Date.now() / 1000) + 7200,
          status: "active",
          model: opts.session.model,
        },
      });
      if (seeded > 0) {
        this.log(`sim: the session was seeded with ${seeded} input messages (the re-seed)`);
      }
      this.tickUsage();
    });
  }

  clock(): number {
    return Math.round((Date.now() - this.t0) * this.k.speed);
  }

  teardown(): void {
    this.closed = true;
    this.open = false;
    for (const timer of this.timers) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  // ── the user ───────────────────────────────────────────────────────────────

  userSays(text: string): void {
    const trimmed = text.trim();
    if (!this.open || this.closed) {
      this.log("sim: no live session — connect first");
      return;
    }
    if (this.muted) {
      this.log("sim: the mic is muted; nothing was heard");
      return;
    }
    if (trimmed === "") {
      return;
    }
    const words = trimmed.split(/\s+/);
    const perWordMs = 1000 / this.k.wordsPerSecond;
    const startAt = this.clock();
    for (let i = 0; i < words.length; i += WORDS_PER_DELTA) {
      const chunk = words.slice(i, i + WORDS_PER_DELTA);
      const start = startAt + i * perWordMs;
      const end = start + chunk.length * perWordMs;
      this.after(i * perWordMs, () =>
        this.emit({
          type: "session.input_transcript.delta",
          delta: `${chunk.join(" ")} `,
          start_ms: Math.round(start),
          end_ms: Math.round(end),
        }),
      );
    }
    const spoken = words.length * perWordMs;
    if (GREETING.test(trimmed)) {
      this.log("sim: a greeting — the delegation policy says answer it yourself, no ticket");
      this.after(spoken + 400, () => this.speak("Hi. I'm listening.", 0));
      return;
    }
    this.after(spoken + this.k.delegateAfterMs, () =>
      this.delegate(trimmed, Math.round(startAt + spoken)),
    );
  }

  // ── the voice model ────────────────────────────────────────────────────────

  private delegate(request: string, offsetMs: number): void {
    const target = this.opts.session.delegation?.type === "responses" ? "responses" : "client";
    const n = this.delegations.size + 1;
    const delegation: Delegation = {
      id: `item_sim_${String(n).padStart(3, "0")}`,
      target,
      request,
      spoke: false,
      responseId: target === "responses" ? `resp_sim_${n}` : undefined,
    };
    this.delegations.set(delegation.id, delegation);
    this.emit({
      type: "session.delegation.created",
      offset_ms: offsetMs,
      delegation: {
        id: delegation.id,
        type: "delegation",
        target,
        ...(delegation.responseId !== undefined ? { response_id: delegation.responseId } : {}),
      },
    });
    if (this.k.acknowledgeDelegation) {
      this.after(170, () => this.speak("Okay, hang on.", 0));
    }
    if (target === "responses") {
      this.hosted(delegation);
    }
  }

  /** Stream output-transcript fragments for `text`, after `delayMs`, never overlapping. */
  private speak(text: string, delayMs: number): void {
    const words = text.split(/\s+/).filter((word) => word !== "");
    if (words.length === 0) {
      return;
    }
    const perWordMs = 1000 / this.k.wordsPerSecond;
    const startAt = Math.max(this.clock() + delayMs, this.speakingUntil + 150);
    const lead = startAt - this.clock();
    for (let i = 0; i < words.length; i += WORDS_PER_DELTA) {
      const chunk = words.slice(i, i + WORDS_PER_DELTA);
      const start = startAt + i * perWordMs;
      const end = start + chunk.length * perWordMs;
      this.after(lead + i * perWordMs, () =>
        this.emit({
          type: "session.output_transcript.delta",
          delta: `${chunk.join(" ")} `,
          start_ms: Math.round(start),
          end_ms: Math.round(end),
        }),
      );
    }
    this.speakingUntil = startAt + words.length * perWordMs;
  }

  private prefixed(delegation: Delegation | undefined, text: string): string {
    if (delegation === undefined || !this.k.paraphrase || delegation.spoke) {
      return text;
    }
    delegation.spoke = true;
    return `Alright. ${text}`;
  }

  // ── the hosted Responses loop (toy) ────────────────────────────────────────

  private hosted(delegation: Delegation): void {
    const config = this.opts.session.delegation;
    const tools = config?.type === "responses" ? (config.responses.tools ?? []) : [];
    const names = tools
      .filter((tool) => tool.type === "function")
      .map((tool) => (tool as { name: string }).name);
    this.after(150, () =>
      this.emit(
        this.responseEvent(delegation, {
          type: "response.created",
          response: { id: delegation.responseId },
        }),
      ),
    );
    const call = pickCall(delegation.request, names);
    // Measured: delegation → function-call item in 0.77 s (8 reasoning tokens).
    this.after(770, () => {
      if (call === undefined) {
        this.complete(
          delegation,
          `I'd answer that from the conversation alone: you asked "${delegation.request}". The simulated backend has no model, so that is all it can say.`,
        );
        return;
      }
      const callId = `call_sim_${++this.seq}`;
      delegation.pendingCall = { callId, name: call.name };
      this.emit(
        this.responseEvent(delegation, {
          type: "response.output_item.done",
          item: {
            type: "function_call",
            call_id: callId,
            name: call.name,
            arguments: JSON.stringify(call.args),
          },
        }),
      );
    });
  }

  private responseEvent(delegation: Delegation, nested: Record<string, unknown>): LiveEvent {
    return { type: "response.event", delegation_id: delegation.id, event: nested };
  }

  private complete(delegation: Delegation, text: string): void {
    this.emit(
      this.responseEvent(delegation, {
        type: "response.completed",
        response: {
          id: delegation.responseId,
          output: [
            { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
          ],
        },
      }),
    );
    // Measured: the completed text was spoken 0.8 s later.
    this.speak(this.prefixed(delegation, text), 800);
  }

  // ── client events ──────────────────────────────────────────────────────────

  private onClientEvent(event: LiveEvent): void {
    if (this.closed) {
      return;
    }
    const kind = (Object.keys(APPEND_EVENT) as AppendKind[]).find(
      (candidate) => APPEND_EVENT[candidate] === event.type,
    );
    if (kind !== undefined) {
      this.onAppend(kind, event);
      return;
    }
    switch (event.type) {
      case "session.close":
        this.after(200, () => {
          this.emit({
            type: "session.closed",
            reason: "close_requested",
            usage: { seconds: Math.round(this.clock() / 1000) },
          });
          this.after(50, () => {
            this.opts.onClose("data channel closed");
            this.teardown();
          });
        });
        return;
      case "session.input_audio.mute":
        this.muted = true;
        this.after(60, () => this.emit({ type: "session.input_audio.muted" }));
        return;
      case "session.input_audio.unmute":
        this.muted = false;
        this.after(60, () => this.emit({ type: "session.input_audio.unmuted" }));
        return;
      case "session.update":
        this.after(80, () =>
          this.emit({ type: "session.updated", session: { id: this.sessionId, status: "active" } }),
        );
        return;
      case "response.item.create":
        this.onItem(event);
        return;
      case "response.create":
        this.onResponseCreate();
        return;
      default:
        this.after(50, () =>
          this.emit({
            type: "error",
            error: {
              type: "invalid_request_error",
              code: "unknown_event",
              message: `Unknown client event type '${event.type}'.`,
              client_event_id: typeof event.event_id === "string" ? event.event_id : null,
            },
          }),
        );
    }
  }

  private onAppend(kind: AppendKind, event: LiveEvent): void {
    const clientEventId = typeof event.event_id === "string" ? event.event_id : null;
    const delegationId = event.delegation_id;
    const content = typeof event.content === "string" ? event.content : "";
    const fail = (code: string | null, message: string) =>
      this.after(120, () =>
        this.emit({
          type: "error",
          error: {
            type: "invalid_request_error",
            code,
            message,
            param: code === null ? "delegation_id" : "content",
            client_event_id: clientEventId,
          },
        }),
      );
    if (
      delegationId !== null &&
      (typeof delegationId !== "string" || !this.delegations.has(delegationId))
    ) {
      fail(null, "Unknown client delegation.");
      return;
    }
    if (approxTokens(content) > APPEND_TOKEN_LIMIT) {
      fail("invalid_value", "Context append text must not exceed 500 tokens.");
      return;
    }
    const delegation =
      typeof delegationId === "string" ? this.delegations.get(delegationId) : undefined;
    this.after(this.k.ackAfterMs, () => {
      const at = this.clock();
      this.emit({
        type: APPENDED_EVENT[kind],
        client_event_id: clientEventId,
        delegation_id: delegationId ?? null,
        start_ms: at,
        end_ms: at + 20,
      });
    });
    if (kind === "commentary") {
      this.speak(this.prefixed(delegation, content), this.k.speakAfterMs);
    } else if (kind === "thinking" && this.k.narrateThinking) {
      this.speak(`Quick update: ${content}`, this.k.speakAfterMs);
    } else if (kind === "instructions") {
      this.log(
        "sim: instructions appended — the real model treats it as a directive (it can interrupt speech); the simulator only records it",
      );
    }
  }

  private onItem(event: LiveEvent): void {
    const item = event.item as
      | { type?: string; call_id?: string; output?: unknown; content?: unknown }
      | undefined;
    if (item?.type === "function_call_output" && typeof item.call_id === "string") {
      for (const delegation of this.delegations.values()) {
        if (delegation.pendingCall?.callId === item.call_id) {
          delegation.pendingCall.output = item.output;
          return;
        }
      }
      this.log(`sim: function_call_output for an unknown call_id ${item.call_id}`);
      return;
    }
    if (item?.type === "message") {
      const parts = Array.isArray(item.content) ? (item.content as Array<{ text?: string }>) : [];
      this.pendingTyped = parts.map((part) => part.text ?? "").join(" ");
      this.log(
        "sim: a typed user message for the hosted backend — the simulator opens a fresh delegation for it (this path is unverified against the real API)",
      );
    }
  }

  private onResponseCreate(): void {
    for (const delegation of this.delegations.values()) {
      const call = delegation.pendingCall;
      if (call !== undefined && "output" in call) {
        delegation.pendingCall = undefined;
        const brief = JSON.stringify(call.output ?? null).slice(0, 140);
        // Measured: tool result → response.completed in 0.24 s.
        this.after(240, () => this.complete(delegation, `Done. ${call.name} returned ${brief}.`));
        return;
      }
    }
    const typed = this.pendingTyped;
    if (typed !== undefined) {
      this.pendingTyped = undefined;
      const n = this.delegations.size + 1;
      const delegation: Delegation = {
        id: `item_sim_${String(n).padStart(3, "0")}`,
        target: "responses",
        request: typed,
        spoke: false,
        responseId: `resp_sim_${n}`,
      };
      this.delegations.set(delegation.id, delegation);
      this.hosted(delegation);
    }
  }

  // ── plumbing ───────────────────────────────────────────────────────────────

  private tickUsage(): void {
    // Measured: usage snapshots about every 15 s.
    this.after(15000, () => {
      this.emit({
        type: "session.usage.updated",
        usage: { seconds: Math.round(this.clock() / 1000) },
        context_window: { usage_ratio: Math.min(0.9, this.clock() / 7_200_000) },
      });
      this.tickUsage();
    });
  }

  private after(ms: number, fn: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (!this.closed) {
        fn();
      }
    }, Math.max(0, ms) / this.k.speed);
    this.timers.add(timer);
  }

  private emit(event: LiveEvent): void {
    if (this.closed) {
      return;
    }
    this.opts.onEvent({ event_id: `s_${++this.seq}`, ...event });
  }
}

/** The toy backend's "reasoning": a keyword picks one of the declared tools. */
function pickCall(
  request: string,
  names: string[],
): { name: string; args: Record<string, unknown> } | undefined {
  const text = request.toLowerCase();
  if (names.includes("clock") && /\b(time|clock|date)\b/.test(text)) {
    return { name: "clock", args: {} };
  }
  if (names.includes("add") && /\b(add|plus|sum)\b/.test(text)) {
    const numbers = text.match(/-?\d+(\.\d+)?/g) ?? [];
    return { name: "add", args: { a: Number(numbers[0] ?? 0), b: Number(numbers[1] ?? 0) } };
  }
  if (names.includes("slow_lookup") && /\blook/.test(text)) {
    const seconds = /(\d+)\s*second/.exec(text);
    const term =
      /look(?: it)? up\s+(?:the\s+)?([a-z][a-z\s-]*?)(?:,|\.|\s+take|\s+and|$)/
        .exec(text)?.[1]
        ?.trim() ?? "that";
    return { name: "slow_lookup", args: { term, seconds: seconds ? Number(seconds[1]) : 3 } };
  }
  const direct = names.find(
    (name) => text.includes(name.replace(/_/g, " ")) || text.includes(name),
  );
  return direct === undefined ? undefined : { name: direct, args: {} };
}
