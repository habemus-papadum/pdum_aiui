/**
 * The session engine, driven through a scripted transport (no network, no
 * key, no DOM) — the contracts that must hold whatever the transport:
 * event_id stamping, the completed-response tool gate, in-band tool errors,
 * live-surface reconciliation, park semantics, and the total ledger (unknown
 * vendor events retained as `raw`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OracleSession } from "./session";
import type {
  KeySource,
  LedgerEntry,
  OracleConfig,
  OracleTool,
  OracleTransport,
  PromptContext,
} from "./types";
import { groupTurns } from "./widgets/viewer-model";

const testKeys: KeySource = {
  describe: () => "test-keys",
  credential: async () => ({ ek: "ek_test", expiresAt: 0 }),
};

function fakeTransport() {
  const sent: Array<Record<string, unknown>> = [];
  const mic: boolean[] = [];
  let connectOptions: Parameters<OracleTransport["connect"]>[0] | undefined;
  const transport: OracleTransport = {
    name: "fake",
    capabilities: {
      replyAudioData: false,
      serverBargeIn: true,
      injectAudio: false,
      sideband: true,
    },
    async connect(options) {
      connectOptions = options;
      return {
        send: (event) => sent.push(event),
        setMicEnabled: (on) => mic.push(on),
        interrupt: () => sent.push({ type: "__interrupt" }),
        callId: "rtc_test",
        close: () => {},
      };
    },
  };
  return {
    transport,
    sent,
    mic,
    emit: (event: Record<string, unknown>) => connectOptions?.onEvent(event),
    dropFrom: (reason: string) => connectOptions?.onClose(reason),
  };
}

function makeSession(tools: OracleTool[], rig = fakeTransport()) {
  const session = new OracleSession({
    config: { instructions: "be helpful", tools },
    keySource: testKeys,
    transport: rig.transport,
  });
  return { session, rig };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function doneWithCall(status: string, callId: string, name: string, args: string) {
  return {
    type: "response.done",
    response: {
      id: "resp_1",
      status,
      output: [{ type: "function_call", call_id: callId, name, arguments: args }],
    },
  };
}

describe("start", () => {
  it("opens with a session.update carrying tools, never voice/model, and an event_id", async () => {
    const { session, rig } = makeSession([
      { name: "set_x", description: "set x", parameters: { type: "object" }, execute: () => "ok" },
    ]);
    await session.start();
    expect(session.state().status).toBe("live");
    expect(session.state().callId).toBe("rtc_test");
    const opening = rig.sent[0] as {
      type: string;
      event_id: string;
      session: Record<string, unknown>;
    };
    expect(opening.type).toBe("session.update");
    expect(opening.event_id).toMatch(/^evt_/);
    // GA rejects a session.update without the type discriminator (found at
    // first light) — but voice/model stay frozen fields we never send.
    expect(opening.session.type).toBe("realtime");
    expect(opening.session.voice).toBeUndefined();
    expect(opening.session.model).toBeUndefined();
    expect((opening.session.tools as Array<{ name: string }>).map((t) => t.name)).toEqual([
      "set_x",
    ]);
  });

  it("a key failure is a ledgered error state, not a throw", async () => {
    const rig = fakeTransport();
    const session = new OracleSession({
      config: { instructions: "x" },
      keySource: {
        describe: () => "broken",
        credential: async () => Promise.reject(new Error("no key pasted")),
      },
      transport: rig.transport,
    });
    await session.start();
    expect(session.state().status).toBe("error");
    expect(session.ledger().some((e) => e.kind === "error" && e.source === "key")).toBe(true);
  });
});

describe("replyText across a session's life", () => {
  it("SURVIVES response.done — the audio outlasts the transcript", async () => {
    const { session, rig } = makeSession([]);
    await session.start();
    rig.emit({ type: "response.created" });
    rig.emit({ type: "response.output_audio_transcript.delta", delta: "Paris is " });
    rig.emit({ type: "response.output_audio_transcript.delta", delta: "the capital." });
    rig.emit({ type: "response.done", response: { id: "r1", status: "completed", output: [] } });
    expect(session.state().replying).toBe(false);
    // The line stands: on WebRTC nothing tells us when the SPEECH ends, so a
    // completed transcript must not be read as "nothing is happening".
    expect(session.state().replyText).toBe("Paris is the capital.");
  });

  it("RESETS on start — a reconnect is a new conversation, not a continuation", async () => {
    const { session, rig } = makeSession([]);
    await session.start();
    rig.emit({ type: "response.created" });
    rig.emit({ type: "response.output_audio_transcript.delta", delta: "first session" });
    rig.emit({ type: "response.done", response: { id: "r1", status: "completed", output: [] } });
    expect(session.state().replyText).toBe("first session");

    // A host that holds ONE session for the page's life (the intent panel)
    // reconnects through the same object; the vendor carries no history, so
    // neither may the strip.
    session.close();
    await session.start();
    expect(session.state().replyText).toBe("");
  });
});

describe("the tool gate — response.done status decides execution", () => {
  it("a COMPLETED response executes, returns function_call_output, then one response.create", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const { session, rig } = makeSession([
      {
        name: "set_x",
        description: "set x",
        parameters: { type: "object", properties: { value: { type: "number" } } },
        execute: (args) => {
          calls.push(args);
          return { applied: args.value };
        },
      },
    ]);
    await session.start();
    rig.sent.length = 0;
    rig.emit(doneWithCall("completed", "call_1", "set_x", '{"value": 7}'));
    await settle();
    expect(calls).toEqual([{ value: 7 }]);
    const types = rig.sent.map((event) => event.type);
    expect(types).toEqual(["conversation.item.create", "response.create"]);
    const item = (rig.sent[0] as { item: Record<string, unknown> }).item;
    expect(item.call_id).toBe("call_1");
    expect(JSON.parse(item.output as string)).toEqual({ applied: 7 });
  });

  it("a CANCELLED response NEVER executes — the call is ledgered as cancelled", async () => {
    const calls: unknown[] = [];
    const { session, rig } = makeSession([
      {
        name: "set_x",
        description: "set x",
        parameters: { type: "object" },
        execute: (args) => void calls.push(args),
      },
    ]);
    await session.start();
    rig.sent.length = 0;
    rig.emit(doneWithCall("cancelled", "call_1", "set_x", "{}"));
    await settle();
    expect(calls).toEqual([]);
    // Nothing about the CALL went out — no output, no follow-up response.
    // (Session bookkeeping may still travel; it is not the subject here.)
    expect(rig.sent.filter((event) => event.type !== "session.update")).toEqual([]);
    const entry = session.ledger().find((e) => e.kind === "tool-call") as Extract<
      LedgerEntry,
      { kind: "tool-call" }
    >;
    expect(entry.status).toBe("cancelled");
  });

  it("malformed arguments and thrown tools answer IN-BAND (no strict mode exists)", async () => {
    const { session, rig } = makeSession([
      {
        name: "bad",
        description: "throws",
        parameters: { type: "object" },
        execute: () => {
          throw new Error("cell refused");
        },
      },
    ]);
    await session.start();
    rig.sent.length = 0;
    rig.emit(doneWithCall("completed", "call_1", "bad", "not json"));
    await settle();
    const out1 = JSON.parse(
      ((rig.sent[0] as { item: Record<string, unknown> }).item as { output: string }).output,
    ) as { error: string };
    expect(out1.error).toContain("invalid arguments");

    rig.sent.length = 0;
    rig.emit(doneWithCall("completed", "call_2", "bad", "{}"));
    await settle();
    const out2 = JSON.parse(
      ((rig.sent[0] as { item: Record<string, unknown> }).item as { output: string }).output,
    ) as { error: string };
    expect(out2.error).toBe("cell refused");

    rig.sent.length = 0;
    rig.emit(doneWithCall("completed", "call_3", "no_such_tool", "{}"));
    await settle();
    const out3 = JSON.parse(
      ((rig.sent[0] as { item: Record<string, unknown> }).item as { output: string }).output,
    ) as { error: string };
    expect(out3.error).toContain("unknown tool");
  });
});

describe("the gate's cost is measured", () => {
  it("gateMs = arguments.done → response.done, on the tool-call entry", async () => {
    let clock = 1000;
    const rig = fakeTransport();
    const session = new OracleSession({
      config: {
        instructions: "x",
        tools: [
          { name: "set_x", description: "d", parameters: { type: "object" }, execute: () => null },
        ],
      },
      keySource: testKeys,
      transport: rig.transport,
      now: () => clock,
    });
    await session.start();
    rig.emit({ type: "response.function_call_arguments.done", call_id: "call_1" });
    clock = 1420;
    rig.emit(doneWithCall("completed", "call_1", "set_x", "{}"));
    await settle();
    const entry = session.ledger().find((e) => e.kind === "tool-call") as Extract<
      LedgerEntry,
      { kind: "tool-call" }
    >;
    expect(entry.gateMs).toBe(420);
    // A call whose arguments-done was never seen carries no gateMs.
    rig.emit(doneWithCall("completed", "call_2", "set_x", "{}"));
    await settle();
    const second = session
      .ledger()
      .filter((e) => e.kind === "tool-call")
      .at(-1) as Extract<LedgerEntry, { kind: "tool-call" }>;
    expect(second.gateMs).toBeUndefined();
  });
});

describe("the live surface", () => {
  it("setTools sends a wholesale session.update and reconciles drift from the ack", async () => {
    const { session, rig } = makeSession([]);
    await session.start();
    rig.emit({ type: "session.updated", session: { tools: [] } }); // the opening ack
    rig.sent.length = 0;
    session.setTools([
      { name: "added", description: "new", parameters: { type: "object" }, execute: () => null },
    ]);
    const update = (rig.sent[0] as { session: { type: string; tools: Array<{ name: string }> } })
      .session;
    expect(update.type).toBe("realtime"); // the live path needs the discriminator too
    expect(update.tools).toHaveLength(1);
    // The server acks WITHOUT the tool — drift must be named, not swallowed.
    rig.emit({ type: "session.updated", session: { tools: [] } });
    const entries = session.ledger().filter((e) => e.kind === "config") as Array<
      Extract<LedgerEntry, { kind: "config" }>
    >;
    expect(entries.at(-1)?.drift).toEqual(["tool not held: added"]);
  });
});

describe("park", () => {
  it("gates the mic without closing, and resume reopens it", async () => {
    const { session, rig } = makeSession([]);
    await session.start();
    session.park();
    expect(session.state().status).toBe("parked");
    session.resume();
    expect(session.state().status).toBe("live");
    expect(rig.mic).toEqual([false, true]);
  });
});

describe("the ledger is total", () => {
  it("unknown vendor events are retained as raw, and usage tallies across responses", async () => {
    const { session, rig } = makeSession([]);
    await session.start();
    rig.emit({ type: "somenew.vendor.event", data: 1 });
    const raw = session.ledger().find((e) => e.kind === "raw") as Extract<
      LedgerEntry,
      { kind: "raw" }
    >;
    expect(raw.type).toBe("somenew.vendor.event");

    rig.emit({
      type: "response.done",
      response: {
        id: "r1",
        status: "completed",
        output: [],
        usage: { input_tokens: 100, output_tokens: 40, input_token_details: { cached_tokens: 80 } },
      },
    });
    rig.emit({
      type: "response.done",
      response: {
        id: "r2",
        status: "completed",
        output: [],
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    });
    expect(session.state().usage).toMatchObject({
      inputTokens: 110,
      cachedInputTokens: 80,
      outputTokens: 45,
      responses: 2,
    });
  });

  it("a transport drop is a ledgered close, not silence", async () => {
    const { session, rig } = makeSession([]);
    await session.start();
    rig.dropFrom("peer connection failed");
    expect(session.state().status).toBe("closed");
    const last = session.ledger().at(-1) as Extract<LedgerEntry, { kind: "session" }>;
    expect(last.detail).toBe("peer connection failed");
  });
});

describe("the mic a talking agent needs, and the VAD it can trip", () => {
  it("asks for echo cancellation EXPLICITLY — it barged in on itself without it", async () => {
    const rig = fakeTransport();
    const asked: MediaStreamConstraints[] = [];
    const { webRtcTransport } = await import("./webrtc");
    const transport = webRtcTransport({
      getUserMedia: async (c) => {
        asked.push(c);
        throw new Error("stop here — the constraints are the assertion");
      },
      createPeerConnection: () => ({ close: () => {} }) as never,
    });
    const session = new OracleSession({
      config: { instructions: "x" },
      keySource: testKeys,
      transport,
    });
    await session.start();
    expect(asked[0]?.audio).toMatchObject({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    });
    expect(rig.sent).toHaveLength(0);
  });

  it("passes VAD tuning through verbatim — ours to send, the vendor's to accept", async () => {
    const rig = fakeTransport();
    const session = new OracleSession({
      config: {
        instructions: "x",
        // Vendor field names, not ours: sent as-is so the `session.updated`
        // echo can be checked rather than the acceptance assumed.
        audio: {
          input: {
            turn_detection: { type: "server_vad", threshold: 0.8, silence_duration_ms: 700 },
          },
        },
      },
      keySource: testKeys,
      transport: rig.transport,
    });
    await session.start();
    const opening = rig.sent[0] as { session: { audio: { input: { turn_detection: unknown } } } };
    expect(opening.session.audio.input.turn_detection).toMatchObject({
      type: "server_vad",
      threshold: 0.8,
      silence_duration_ms: 700,
    });
  });
});

describe("the first-reply echo window", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const guarded = (config: Partial<OracleConfig> = {}, rig = fakeTransport()) => ({
    rig,
    session: new OracleSession({
      config: {
        instructions: "x",
        audio: { input: { turn_detection: { type: "server_vad", threshold: 0.75 } } },
        ...config,
      },
      keySource: testKeys,
      transport: rig.transport,
    }),
  });

  const turnDetection = (event: unknown) =>
    (event as { session: { audio: { input: { turn_detection: Record<string, unknown> } } } })
      .session.audio.input.turn_detection;

  /** Drive one spoken reply, the way the vendor orders it: audio starts, the
   * transcript completes, and only THEN does the audio stop. */
  const speakAReply = (rig: ReturnType<typeof fakeTransport>) => {
    rig.emit({ type: "response.created" });
    rig.emit({ type: "output_audio_buffer.started" });
    rig.emit({ type: "response.done", response: { id: "r1", status: "completed", output: [] } });
    rig.emit({ type: "output_audio_buffer.stopped" });
  };

  it("opens SUPPRESSED — the first reply cannot be truncated or answered by the echo", async () => {
    const { session, rig } = guarded();
    await session.start();
    // The window is a property of the config we send, so it is on from the
    // first byte rather than applied by someone remembering to apply it.
    expect(turnDetection(rig.sent[0])).toEqual({
      type: "server_vad",
      threshold: 0.75,
      interrupt_response: false,
    });
  });

  it("does NOT suppress reply creation — that deadlocks the session mute", async () => {
    // The window closes when a reply happens. `create_response: false` rode
    // here for one commit and made the first utterance produce no reply at
    // all: `response.created` never fires, the cap never starts, and every
    // exit hangs off a response that cannot exist. The session was heard,
    // transcribed, and permanently silent.
    const { session, rig } = guarded();
    await session.start();
    expect(turnDetection(rig.sent[0])).not.toHaveProperty("create_response");

    // The premise the other tests assume and none of them checked: a human
    // utterance still gets answered while the window is open.
    rig.emit({ type: "input_audio_buffer.speech_started" });
    rig.emit({ type: "input_audio_buffer.speech_stopped" });
    rig.emit({ type: "response.created" });
    rig.emit({ type: "output_audio_buffer.started" });
    rig.emit({ type: "response.done", response: { id: "r1", status: "completed", output: [] } });
    rig.emit({ type: "output_audio_buffer.stopped" });
    await vi.advanceTimersByTimeAsync(400);
    expect(session.ledger().some((e) => e.kind === "sent")).toBe(true);
  });

  it("arms when the reply's AUDIO stops — not when its transcript does", async () => {
    const { session, rig } = guarded();
    await session.start();
    rig.sent.length = 0;
    rig.emit({ type: "response.created" });
    rig.emit({ type: "output_audio_buffer.started" });
    rig.emit({ type: "response.done", response: { id: "r1", status: "completed", output: [] } });
    // response.done is NOT the signal: the transcript finishes seconds ahead
    // of the speech, and arming here re-opens the very hazard being guarded.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(rig.sent).toEqual([]);

    rig.emit({ type: "output_audio_buffer.stopped" });
    // Still not instantly — `stopped` means the SERVER stopped sending.
    expect(rig.sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(400);
    // The restore is EXPLICIT: `interrupt_response` was sent as false, so it
    // must be re-stated, not omitted — under the vendor's (unverified) merge
    // semantics an omitted key keeps its last sent value.
    expect(turnDetection(rig.sent[0])).toEqual({
      type: "server_vad",
      threshold: 0.75,
      interrupt_response: true,
    });
    // …and arming is attributable: a barge-in after this line is the vendor's.
    const armed = session.ledger().filter((e) => e.kind === "sent");
    expect((armed[0] as { type: string }).type).toContain("interrupts armed");
  });

  it("arms ONCE — a later reply does not re-send the block", async () => {
    const { session, rig } = guarded();
    await session.start();
    speakAReply(rig);
    await vi.advanceTimersByTimeAsync(400);
    rig.sent.length = 0;
    speakAReply(rig);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(rig.sent).toEqual([]);
  });

  it("the cap is the way out when the end-of-audio event never comes", async () => {
    // It is undocumented and reported to arrive late; it never gets to be the
    // only exit, or a missing event disables barge-in for the whole session.
    const { session, rig } = guarded({ firstReplyGuard: { maxMs: 9_000 } });
    await session.start();
    rig.sent.length = 0;
    rig.emit({ type: "response.created" });
    rig.emit({ type: "output_audio_buffer.started" });
    await vi.advanceTimersByTimeAsync(8_999);
    expect(rig.sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(turnDetection(rig.sent[0])).toEqual({
      type: "server_vad",
      threshold: 0.75,
      interrupt_response: true,
    });
  });

  it("a reply that never SPOKE closes the window immediately — no echo to guard", async () => {
    const { session, rig } = guarded();
    await session.start();
    rig.sent.length = 0;
    rig.emit({ type: "response.created" });
    rig.emit({ type: "response.done", response: { id: "r1", status: "failed", output: [] } });
    expect(turnDetection(rig.sent[0])).toEqual({
      type: "server_vad",
      threshold: 0.75,
      interrupt_response: true,
    });
  });

  it("the reply's audio lifecycle is LEDGERED — it used to be dropped as chatter", async () => {
    const { session, rig } = guarded();
    await session.start();
    speakAReply(rig);
    const phases = session
      .ledger()
      .filter((e) => e.kind === "reply-audio")
      .map((e) => (e as { phase: string }).phase);
    expect(phases).toEqual(["started", "stopped"]);
  });

  it("opt out with false, and manual turn control has nothing to suppress", async () => {
    const off = guarded({ firstReplyGuard: false });
    await off.session.start();
    expect(turnDetection(off.rig.sent[0])).toEqual({ type: "server_vad", threshold: 0.75 });
    off.rig.sent.length = 0;
    speakAReply(off.rig);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(off.rig.sent).toEqual([]);

    // `turn_detection: null` is the vendor's manual mode — there is no object to
    // carry the suppression, so the window must not open (and must not then
    // try to close by sending an update).
    const manual = guarded({ audio: { input: { turn_detection: null } } });
    await manual.session.start();
    expect(turnDetection(manual.rig.sent[0])).toBeNull();
    manual.rig.sent.length = 0;
    speakAReply(manual.rig);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(manual.rig.sent).toEqual([]);
  });

  it("a GREETING speaks first, and the window carries BOTH suppressions for it", async () => {
    const { session, rig } = guarded({ greeting: "Hi there — connected and listening." });
    await session.start();
    // With a greeting the echo cannot truncate the reply OR be answered as a
    // user turn — safe only because the reply is created explicitly below.
    expect(turnDetection(rig.sent[0])).toEqual({
      type: "server_vad",
      threshold: 0.75,
      interrupt_response: false,
      create_response: false,
    });
    const create = rig.sent[1] as { type: string; response: { instructions: string } };
    expect(create.type).toBe("response.create");
    expect(create.response.instructions).toContain("Hi there — connected and listening.");
    // Attributable in the ledger: a response.create with no user turn before
    // it is OURS, and named as the greeting.
    const sent = session.ledger().filter((e) => e.kind === "sent");
    expect(sent.map((e) => (e as { type: string }).type)).toEqual(["greeting", "response.create"]);
  });

  it("the greeting reply CLOSES the window — the explicit create dodges the deadlock", async () => {
    const { session, rig } = guarded({ greeting: "Hi." });
    await session.start();
    rig.sent.length = 0;
    speakAReply(rig);
    await vi.advanceTimersByTimeAsync(400);
    // Armed: both suppressions restored EXPLICITLY to true, never dropped by
    // omission — the live failure this pins was the server keeping
    // `create_response: false` after an armed update that merely omitted it,
    // which left every later utterance heard, committed, and never answered.
    expect(turnDetection(rig.sent[0])).toEqual({
      type: "server_vad",
      threshold: 0.75,
      interrupt_response: true,
      create_response: true,
    });
  });

  it("a greeting WITHOUT the guard still speaks — priming is independent of suppression", async () => {
    const { session, rig } = guarded({ greeting: "Hi.", firstReplyGuard: false });
    await session.start();
    expect(turnDetection(rig.sent[0])).toEqual({ type: "server_vad", threshold: 0.75 });
    expect(rig.sent.some((event) => event.type === "response.create")).toBe(true);
  });

  it("a RECONNECT re-opens it — a new peer connection has learned nothing", async () => {
    const { session, rig } = guarded();
    await session.start();
    speakAReply(rig);
    await vi.advanceTimersByTimeAsync(400);
    session.close();

    rig.sent.length = 0;
    await session.start();
    // The echo canceller is per-connection and adaptive; the second session
    // starts as naive about the room as the first did.
    expect(turnDetection(rig.sent[0])).toMatchObject({ interrupt_response: false });
  });
});

describe("the live line records what the browser ACTUALLY granted", () => {
  it("names the processing that is on — the fact a closed session can no longer be asked for", async () => {
    const rig = fakeTransport();
    const withAudio: OracleTransport = {
      ...rig.transport,
      connect: async (options) => ({
        ...(await rig.transport.connect(options)),
        audioSettings: () => ({
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        }),
      }),
    };
    const session = new OracleSession({
      config: { instructions: "x" },
      keySource: testKeys,
      transport: withAudio,
    });
    await session.start();
    const live = session
      .ledger()
      .find((e) => e.kind === "session" && e.phase === "live") as Extract<
      LedgerEntry,
      { kind: "session" }
    >;
    expect(live.detail).toContain("mic: aec+ns+agc");
  });

  it("says NO PROCESSING loudly when the device refused it all", async () => {
    const rig = fakeTransport();
    const bare: OracleTransport = {
      ...rig.transport,
      connect: async (options) => ({
        ...(await rig.transport.connect(options)),
        audioSettings: () => ({ echoCancellation: false }),
      }),
    };
    const session = new OracleSession({
      config: { instructions: "x" },
      keySource: testKeys,
      transport: bare,
    });
    await session.start();
    const live = session
      .ledger()
      .find((e) => e.kind === "session" && e.phase === "live") as Extract<
      LedgerEntry,
      { kind: "session" }
    >;
    // Constraints are REQUESTS; a device or OS can refuse one silently, and
    // that refusal is the whole explanation for a reply that interrupts itself.
    expect(live.detail).toContain("mic: NO PROCESSING");
  });
});

describe("attributing a cancellation — was it us or the vendor?", () => {
  it("records the response.create WE send after a tool, so the record is two-sided", async () => {
    const { session, rig } = makeSession([
      { name: "set_x", description: "", parameters: { type: "object" }, execute: () => "ok" },
    ]);
    await session.start();
    rig.emit(doneWithCall("completed", "call_1", "set_x", "{}"));
    await settle();
    const sent = session.ledger().filter((e) => e.kind === "sent");
    expect(sent.map((e) => (e as { type: string }).type)).toEqual(["response.create"]);
  });

  it("a deliberate shush is DISTINGUISHABLE from a vendor barge-in in the ledger", async () => {
    const { session, rig } = makeSession([]);
    await session.start();

    // The vendor cancelling on detected speech: an inbound `response.done`
    // with no outbound line before it. The reply is SPEAKING when it happens —
    // which is both what a real barge-in looks like and what keeps the
    // first-reply window open, so the only `sent` lines are the ones under test.
    rig.emit({ type: "response.created" });
    rig.emit({ type: "output_audio_buffer.started" });
    rig.emit({ type: "input_audio_buffer.speech_started" });
    rig.emit({ type: "response.done", response: { id: "r1", status: "cancelled", output: [] } });
    expect(session.ledger().filter((e) => e.kind === "sent")).toHaveLength(0);

    // A shush: an outbound line, and only then the cancellation.
    session.stopSpeaking();
    rig.emit({ type: "response.done", response: { id: "r2", status: "cancelled", output: [] } });
    const sent = session.ledger().filter((e) => e.kind === "sent");
    expect(sent).toHaveLength(1);
    expect((sent[0] as { type: string }).type).toBe("interrupt (shush)");
  });
});

describe("the anti-self-interrupt tuning, and proving the vendor took it", () => {
  it("sends far_field noise reduction beside turn_detection, not inside it", async () => {
    const rig = fakeTransport();
    const session = new OracleSession({
      config: {
        instructions: "x",
        audio: {
          input: {
            noise_reduction: { type: "far_field" },
            turn_detection: { type: "server_vad", threshold: 0.75 },
          },
        },
      },
      keySource: testKeys,
      transport: rig.transport,
    });
    await session.start();
    const input = (rig.sent[0] as { session: { audio: { input: Record<string, unknown> } } })
      .session.audio.input;
    expect(input.noise_reduction).toEqual({ type: "far_field" });
    expect(input.turn_detection).toMatchObject({ type: "server_vad", threshold: 0.75 });
  });

  it("DRIFT names a tuning field the server did not take — the whole point of the echo", async () => {
    const rig = fakeTransport();
    const session = new OracleSession({
      config: {
        instructions: "x",
        audio: {
          input: {
            noise_reduction: { type: "far_field" },
            turn_detection: { type: "server_vad", threshold: 0.75 },
          },
        },
      },
      keySource: testKeys,
      transport: rig.transport,
    });
    await session.start();
    // The server acks with the DEFAULT threshold and no noise reduction — the
    // silent-ignore case that "we set it" would otherwise paper over.
    rig.emit({
      type: "session.updated",
      session: { audio: { input: { turn_detection: { type: "server_vad", threshold: 0.5 } } } },
    });
    const config = session.ledger().find((e) => e.kind === "config") as Extract<
      LedgerEntry,
      { kind: "config" }
    >;
    expect(config.drift?.join(" ")).toContain("turn_detection.threshold: sent 0.75, holds 0.5");
    expect(config.drift?.join(" ")).toContain("noise_reduction not held");
  });

  it("re-tuning mid-session sends the WHOLE audio.input block, not the changed field", async () => {
    const rig = fakeTransport();
    const session = new OracleSession({
      config: {
        instructions: "x",
        audio: {
          input: {
            noise_reduction: { type: "far_field" },
            turn_detection: { type: "server_vad", threshold: 0.75 },
          },
        },
      },
      keySource: testKeys,
      transport: rig.transport,
    });
    await session.start();
    rig.sent.length = 0;
    session.setSessionParam("audio.input.turn_detection.silence_duration_ms", 800);
    const input = (rig.sent[0] as { session: { audio: { input: Record<string, unknown> } } })
      .session.audio.input;
    // A lone `{ silence_duration_ms }` would drop type and threshold if the
    // vendor replaces rather than merges inside turn_detection — unverified,
    // so the block is always a complete statement of intent.
    expect(input.turn_detection).toMatchObject({
      type: "server_vad",
      threshold: 0.75,
      silence_duration_ms: 800,
    });
    expect(input.noise_reduction).toEqual({ type: "far_field" });
  });

  it("no drift when the server holds exactly what we asked for", async () => {
    const rig = fakeTransport();
    const session = new OracleSession({
      config: {
        instructions: "x",
        audio: {
          input: {
            noise_reduction: { type: "far_field" },
            turn_detection: { type: "server_vad", threshold: 0.75 },
          },
        },
      },
      keySource: testKeys,
      transport: rig.transport,
    });
    await session.start();
    const sentSession = (rig.sent[0] as { session: Record<string, unknown> }).session;
    rig.emit({ type: "session.updated", session: sentSession });
    const config = session.ledger().find((e) => e.kind === "config") as Extract<
      LedgerEntry,
      { kind: "config" }
    >;
    expect(config.drift).toEqual([]);
  });
});

describe("the prompt as a RECIPE — slots, resolvers, and when they run", () => {
  /** Starts a session, capturing what the MINT was handed (the composed wire
   * config) as distinct from what the opening update carried. */
  const started = async (config: Partial<OracleConfig>) => {
    const rig = fakeTransport();
    let minted: Record<string, unknown> | undefined;
    const session = new OracleSession({
      config: { instructions: "x", firstReplyGuard: false, ...config } as OracleConfig,
      keySource: {
        describe: () => "test-keys",
        credential: async (wire) => {
          minted = wire;
          return { ek: "ek_test", expiresAt: 0 };
        },
      },
      transport: rig.transport,
    });
    await session.start();
    return { rig, session, minted: () => minted };
  };
  const instructionsOf = (event: unknown) =>
    (event as { session: { instructions?: string } }).session.instructions;

  it("composes BEFORE the mint — the baked config is already right", async () => {
    // The old shape could only correct itself after connecting: mint a prompt
    // known to be stale, then spend a second whole-prompt send replacing it.
    const { minted, rig } = await started({
      instructions: () => "resolved before the credential",
    });
    expect(minted()?.instructions).toBe("resolved before the credential");
    expect(instructionsOf(rig.sent[0])).toBe("resolved before the credential");
  });

  it("hands the resolver the session's own facts", async () => {
    const seen: PromptContext[] = [];
    await started({
      instructions: (context) => {
        seen.push(context);
        return "x";
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ reason: "start", turns: 0, starts: 1 });
  });

  it("a second start is a RECONNECT, and counts", async () => {
    const seen: PromptContext[] = [];
    const { session } = await started({
      instructions: (context) => {
        seen.push(context);
        return "x";
      },
    });
    session.close();
    await session.start();
    expect(seen.map((c) => c.reason)).toEqual(["start", "reconnect"]);
    expect(seen.map((c) => c.starts)).toEqual([1, 2]);
  });

  it("weaves slots into the wire text", async () => {
    const { rig } = await started({ instructions: { app: "A spectrum viewer." } });
    expect(instructionsOf(rig.sent[0])).toContain("About this app: A spectrum viewer.");
  });

  it("a resolver that throws at START fails the session — no silent fallback", async () => {
    // Running on a prompt the app did not mean is worse than not running: the
    // session would answer, plausibly, as something else entirely.
    const { session } = await started({
      instructions: () => {
        throw new Error("no storage");
      },
    });
    expect(session.state().status).toBe("error");
    const error = session.ledger().find((e) => e.kind === "error") as Extract<
      LedgerEntry,
      { kind: "error" }
    >;
    expect(error.source).toBe("prompt");
    expect(error.message).toContain("no storage");
  });

  it("a plain string is usable before any start — the common case never regressed", () => {
    const rig = fakeTransport();
    const session = new OracleSession({
      config: { instructions: "stated outright" },
      keySource: testKeys,
      transport: rig.transport,
    });
    expect(session.sessionConfig().instructions).toBe("stated outright");
  });
});

describe("refreshPrompt — recomposing a running session", () => {
  const started = async (config: Partial<OracleConfig>) => {
    const rig = fakeTransport();
    const session = new OracleSession({
      config: { instructions: "x", firstReplyGuard: false, ...config } as OracleConfig,
      keySource: testKeys,
      transport: rig.transport,
    });
    await session.start();
    rig.sent.length = 0;
    return { rig, session };
  };

  it("sends the new text when the recipe now answers differently", async () => {
    let page = "/one";
    const { rig, session } = await started({ instructions: () => `page ${page}` });
    page = "/two";
    await session.refreshPrompt();
    expect((rig.sent[0] as { session: { instructions: string } }).session.instructions).toBe(
      "page /two",
    );
  });

  it("sends NOTHING when the text is unchanged — the guard that makes this cheap", async () => {
    // Instructions are the largest thing on the session and are re-billed as
    // input tokens every subsequent turn, so a no-op refresh must cost
    // nothing — and must not fill the config ledger with "still the same".
    const { rig, session } = await started({ instructions: () => "steady" });
    await session.refreshPrompt();
    await session.refreshPrompt();
    expect(rig.sent).toEqual([]);
  });

  it("a resolver that throws on REFRESH is recorded, and the session lives", async () => {
    // The opposite call from start: a refresh is an improvement on a session
    // that already works, and losing the improvement beats losing the session.
    let fail = false;
    const { session } = await started({
      instructions: () => {
        if (fail) {
          throw new Error("storage gone");
        }
        return "fine";
      },
    });
    fail = true;
    await session.refreshPrompt();
    expect(session.state().status).toBe("live");
    const error = session.ledger().find((e) => e.kind === "error") as Extract<
      LedgerEntry,
      { kind: "error" }
    >;
    expect(error.source).toBe("prompt");
  });

  it("setInstructions takes manual control, and still reaches the wire", async () => {
    const { rig, session } = await started({ instructions: () => "resolved" });
    session.setInstructions("stated by hand");
    expect((rig.sent[0] as { session: { instructions: string } }).session.instructions).toBe(
      "stated by hand",
    );
    // The recipe is REPLACED — an app that took the wheel keeps it.
    rig.sent.length = 0;
    await session.refreshPrompt();
    expect(rig.sent).toEqual([]);
  });
});

describe("turns — the count a resolver reads", () => {
  const started = async (config: Partial<OracleConfig> = {}) => {
    const rig = fakeTransport();
    const session = new OracleSession({
      config: { instructions: "x", firstReplyGuard: false, ...config } as OracleConfig,
      keySource: testKeys,
      transport: rig.transport,
    });
    await session.start();
    return { rig, session };
  };

  it("counts a heard utterance, and agrees with the viewer's grouping", async () => {
    const { rig, session } = await started();
    expect(session.state().turns).toBe(0);
    rig.emit({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "make it wider",
    });
    expect(session.state().turns).toBe(1);
    // Same predicate, so the number and the turns a human sees cannot diverge.
    expect(groupTurns(session.ledger()).filter((group) => group.id > 0)).toHaveLength(1);
  });

  it("resets on reconnect — a new vendor session remembers nothing", async () => {
    const { rig, session } = await started();
    rig.emit({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "one",
    });
    expect(session.state().turns).toBe(1);
    session.close();
    await session.start();
    expect(session.state().turns).toBe(0);
  });

  it("recompose: each-turn re-runs the resolver once the reply has landed", async () => {
    const seen: PromptContext[] = [];
    const { rig } = await started({
      recompose: "each-turn",
      instructions: (context) => {
        seen.push(context);
        return `turn ${context.turns}`;
      },
    });
    rig.emit({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "hello",
    });
    rig.emit({ type: "response.done", response: { id: "r1", status: "completed", output: [] } });
    await Promise.resolve();
    await Promise.resolve();
    expect(seen.map((c) => c.reason)).toEqual(["start", "refresh"]);
    expect(seen.at(-1)?.turns).toBe(1);
  });

  it("does NOT recompose when tool calls follow — that turn is still running", async () => {
    const seen: PromptContext[] = [];
    const { rig } = await started({
      recompose: "each-turn",
      tools: [
        {
          name: "set_freq",
          description: "d",
          parameters: {},
          execute: () => ({ ok: true }),
        },
      ],
      instructions: (context) => {
        seen.push(context);
        return "x";
      },
    });
    rig.emit({
      type: "response.done",
      response: {
        id: "r1",
        status: "completed",
        output: [{ type: "function_call", call_id: "c1", name: "set_freq", arguments: "{}" }],
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    // Recomposing here would change the instructions under the very reply
    // those tool results are about to produce.
    expect(seen.map((c) => c.reason)).toEqual(["start"]);
  });
});

describe("the greeting as a recipe", () => {
  const started = async (config: Partial<OracleConfig>) => {
    const rig = fakeTransport();
    const session = new OracleSession({
      config: { instructions: "x", firstReplyGuard: false, ...config } as OracleConfig,
      keySource: testKeys,
      transport: rig.transport,
    });
    await session.start();
    return { rig, session };
  };
  const greetingInstructions = (sent: Array<Record<string, unknown>>) =>
    (
      sent.find((e) => e.type === "response.create") as
        | { response?: { instructions?: string } }
        | undefined
    )?.response?.instructions;

  it("a string keeps the say-exactly-this frame — the priming form, unchanged", async () => {
    const { rig } = await started({ greeting: "Hi there." });
    expect(greetingInstructions(rig.sent)).toBe(
      'Open the conversation by saying exactly: "Hi there.". Say nothing else.',
    );
  });

  it("an object hands the model a BRIEF instead", async () => {
    const { rig } = await started({
      greeting: { instructions: "Greet them by name and offer the two-minute tour." },
    });
    expect(greetingInstructions(rig.sent)).toBe(
      "Greet them by name and offer the two-minute tour.",
    );
  });

  it("a resolver picks the opening from the session's facts", async () => {
    const { rig } = await started({
      greeting: (context) =>
        context.starts === 1 ? { instructions: "Welcome them warmly." } : "Back again.",
    });
    expect(greetingInstructions(rig.sent)).toBe("Welcome them warmly.");
  });

  it("undefined from a resolver means NO greeting this time", async () => {
    const { rig } = await started({ greeting: () => undefined });
    expect(greetingInstructions(rig.sent)).toBeUndefined();
  });

  it("resolves EXACTLY ONCE per start — the echo window depends on it", async () => {
    // `greetingText` is read while the audio block is built: it decides
    // whether the window carries `create_response: false` and whether closing
    // it restores the value. A resolver re-invoked at each read could answer
    // differently between them and leave the session permanently mute — the
    // 2026-08-13 failure, one layer up.
    let calls = 0;
    const { rig } = await started({
      firstReplyGuard: true,
      audio: { input: { turn_detection: { type: "server_vad" } } },
      greeting: () => {
        calls += 1;
        return calls === 1 ? "Hi." : undefined;
      },
    });
    expect(calls).toBe(1);
    const opening = (
      rig.sent[0] as { session: { audio: { input: { turn_detection: Record<string, unknown> } } } }
    ).session.audio.input.turn_detection;
    expect(opening).toMatchObject({ create_response: false, interrupt_response: false });
  });
});

describe("reasoning.effort — how hard the model thinks before it answers", () => {
  const started = async (config: Partial<OracleConfig>) => {
    const rig = fakeTransport();
    /** Captures what the MINT was handed — the wire session, frozen fields
     * and all — which is a different object from the opening update. */
    let minted: Record<string, unknown> | undefined;
    const session = new OracleSession({
      config: { instructions: "x", firstReplyGuard: false, ...config },
      keySource: {
        describe: () => "test-keys",
        credential: async (wire) => {
          minted = wire;
          return { ek: "ek_test", expiresAt: 0 };
        },
      },
      transport: rig.transport,
    });
    await session.start();
    return { rig, session, minted: () => minted };
  };
  const sentSession = (event: unknown) => (event as { session: Record<string, unknown> }).session;

  it("rides both the mint and the opening update when set", async () => {
    const { rig, minted } = await started({ reasoning: { effort: "high" } });
    expect(minted()?.reasoning).toEqual({ effort: "high" });
    expect(sentSession(rig.sent[0]).reasoning).toEqual({ effort: "high" });
  });

  it("is absent entirely when unset — that is the vendor's default, not a value", async () => {
    const { rig, minted } = await started({});
    expect(Object.hasOwn(minted() ?? {}, "reasoning")).toBe(false);
    expect(Object.hasOwn(sentSession(rig.sent[0]), "reasoning")).toBe(false);
  });

  it("retunes live — no reconnect, since only voice and model are frozen", async () => {
    const { rig, session } = await started({ reasoning: { effort: "low" } });
    rig.sent.length = 0;
    session.setSessionParam("reasoning.effort", "xhigh");
    expect(sentSession(rig.sent[0]).reasoning).toEqual({ effort: "xhigh" });
  });

  it("clearing the row sends NO block, not an empty one", async () => {
    const { rig, session } = await started({ reasoning: { effort: "high" } });
    rig.sent.length = 0;
    // setPath deletes the leaf and leaves `reasoning: {}` behind in the
    // config. An empty block is not the same statement as "your default", so
    // the send is rebuilt from the leaf rather than passed through.
    session.setSessionParam("reasoning.effort", undefined);
    expect(Object.hasOwn(sentSession(rig.sent[0]), "reasoning")).toBe(false);
  });

  it("DRIFT names an effort the model quietly did not take", async () => {
    const { rig, session } = await started({ reasoning: { effort: "high" } });
    // A model that cannot reason does not refuse the field — it just does not
    // act on it. Echoing `low` back is the whole failure mode, and from our
    // side it is indistinguishable from success without this check.
    rig.emit({ type: "session.updated", session: { reasoning: { effort: "low" } } });
    const config = session.ledger().find((e) => e.kind === "config") as Extract<
      LedgerEntry,
      { kind: "config" }
    >;
    expect(config.drift?.join(" ")).toContain('reasoning.effort: sent "high", holds "low"');
  });

  it("DRIFT names a server that dropped the block outright", async () => {
    const { rig, session } = await started({ reasoning: { effort: "high" } });
    rig.emit({ type: "session.updated", session: { instructions: "x" } });
    const config = session.ledger().find((e) => e.kind === "config") as Extract<
      LedgerEntry,
      { kind: "config" }
    >;
    expect(config.drift).toContain("reasoning not held");
  });

  it("no drift when the server holds the effort we asked for", async () => {
    const { rig, session } = await started({ reasoning: { effort: "medium" } });
    rig.emit({ type: "session.updated", session: sentSession(rig.sent[0]) });
    const config = session.ledger().find((e) => e.kind === "config") as Extract<
      LedgerEntry,
      { kind: "config" }
    >;
    expect(config.drift).toEqual([]);
  });
});

describe("the live params surface — what the two knob-boards write through", () => {
  const tuned = () => {
    const rig = fakeTransport();
    return {
      rig,
      session: new OracleSession({
        config: {
          instructions: "x",
          audio: { input: { turn_detection: { type: "server_vad", threshold: 0.75 } } },
          // Off, so these assertions read the CONFIGURED block rather than the
          // block with the echo window's `interrupt_response: false` layered
          // over it. The window has its own tests; this describe is about what
          // the knob-boards write.
          firstReplyGuard: false,
        },
        keySource: testKeys,
        transport: rig.transport,
      }),
    };
  };
  const turnDetection = (event: unknown) =>
    (event as { session: { audio: { input: { turn_detection: Record<string, unknown> } } } })
      .session.audio.input.turn_detection;

  it("switching type DROPS the other algorithm's knobs", async () => {
    const { session, rig } = tuned();
    await session.start();
    rig.sent.length = 0;
    session.setSessionParam("audio.input.turn_detection.type", "semantic_vad");
    // `threshold` does not exist on semantic_vad. Sending it anyway would be
    // us manufacturing the drift the drift check exists to catch.
    expect(turnDetection(rig.sent[0])).toEqual({ type: "semantic_vad" });
    session.setSessionParam("audio.input.turn_detection.eagerness", "low");
    expect(turnDetection(rig.sent[1])).toEqual({ type: "semantic_vad", eagerness: "low" });
  });

  it("undefined UNSETS a field rather than sending it as null", async () => {
    const { session, rig } = tuned();
    await session.start();
    rig.sent.length = 0;
    session.setSessionParam("audio.input.turn_detection.threshold", undefined);
    const held = turnDetection(rig.sent[0]);
    expect(Object.hasOwn(held, "threshold")).toBe(false);
    expect(held).toEqual({ type: "server_vad" });
  });

  it("sessionConfig carries the FROZEN fields the update may not", async () => {
    const { session } = tuned();
    await session.start();
    const config = session.sessionConfig();
    // A params widget must be able to display model/voice even though no
    // session.update is allowed to carry them — otherwise the two rows would
    // render permanently blank and read as "unset".
    expect(config.model).toBeDefined();
    expect((config.audio as { output: { voice: string } }).output.voice).toBeDefined();
  });

  it("effectiveSession is undefined until the server acks, then holds the echo", async () => {
    const { session, rig } = tuned();
    await session.start();
    expect(session.effectiveSession()).toBeUndefined();
    rig.emit({ type: "session.updated", session: { instructions: "held" } });
    expect(session.effectiveSession()).toEqual({ instructions: "held" });
  });

  it("applying mic constraints goes to the TRACK, and a refusal propagates", async () => {
    const rig = fakeTransport();
    const applied: MediaTrackConstraints[] = [];
    const withMic: OracleTransport = {
      ...rig.transport,
      connect: async (options) => ({
        ...(await rig.transport.connect(options)),
        applyAudioConstraints: async (constraints) => {
          applied.push(constraints);
          if (constraints.sampleRate !== undefined) {
            // What a device saying no actually looks like.
            throw new Error("OverconstrainedError");
          }
        },
      }),
    };
    const session = new OracleSession({
      config: { instructions: "x" },
      keySource: testKeys,
      transport: withMic,
    });
    await session.start();
    await session.applyAudioConstraints({ echoCancellation: false });
    expect(applied).toEqual([{ echoCancellation: false }]);
    // Recorded as ours, like every other outbound control — the ledger has to
    // be able to say "the mic changed because we changed it".
    expect(
      session.ledger().some((e) => e.kind === "sent" && e.type.startsWith("applyConstraints")),
    ).toBe(true);

    await expect(session.applyAudioConstraints({ sampleRate: 8_000 })).rejects.toThrow(
      "OverconstrainedError",
    );
  });

  it("a transport with no mic track says so instead of pretending", async () => {
    const { session } = makeSession([]);
    await session.start();
    expect(session.audioSettings()).toBeUndefined();
    await expect(session.applyAudioConstraints({ echoCancellation: true })).rejects.toThrow(
      "no local mic track",
    );
  });
});

describe("the unattended session parks itself", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const walkAway = (config: Partial<OracleConfig> = {}) => {
    const rig = fakeTransport();
    return {
      rig,
      session: new OracleSession({
        config: { instructions: "x", firstReplyGuard: false, ...config },
        keySource: testKeys,
        transport: rig.transport,
      }),
    };
  };

  it("parks after the idle window — the mic closes, the session does NOT", async () => {
    const { session, rig } = walkAway();
    await session.start();
    await vi.advanceTimersByTimeAsync(119_000);
    expect(session.state().status).toBe("live");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(session.state().status).toBe("parked");
    // Park, not close: the mic is gated and the connection stands, so resuming
    // is one click and the conversation is still there.
    expect(rig.mic).toEqual([false]);
    const entry = session.ledger().at(-1) as Extract<LedgerEntry, { kind: "session" }>;
    expect(entry.phase).toBe("parked");
    expect(entry.detail).toContain("idle 120s");
  });

  it("says WHY it parked — walking away is news, parking it yourself is not", async () => {
    const { session } = walkAway();
    await session.start();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(session.state().parkedReason).toBe("idle");
    session.resume();
    expect(session.state().parkedReason).toBeUndefined();
    session.park();
    expect(session.state().parkedReason).toBe("manual");
  });

  it("activity restarts the clock; BOOKKEEPING does not", async () => {
    const { session, rig } = walkAway();
    await session.start();
    await vi.advanceTimersByTimeAsync(100_000);
    rig.emit({ type: "input_audio_buffer.speech_started" });
    await vi.advanceTimersByTimeAsync(100_000);
    expect(session.state().status).toBe("live");

    // A config ack is the session talking to itself. Counting it would keep an
    // abandoned session awake forever — the exact state this exists to end.
    await vi.advanceTimersByTimeAsync(19_000);
    rig.emit({ type: "session.updated", session: {} });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(session.state().status).toBe("parked");
  });

  it("an injected screenshot counts, though no vendor event says so", async () => {
    // The stopwatch hangs off the LEDGER, not the vendor stream, so anything
    // the session considers to have happened resets it — including the panel
    // handing it an image mid-thought.
    const { session } = walkAway();
    await session.start();
    await vi.advanceTimersByTimeAsync(119_000);
    session.sendText("look at this", { respond: false });
    await vi.advanceTimersByTimeAsync(119_000);
    expect(session.state().status).toBe("live");
  });

  it("a parked session stays parked — the clock does not run against itself", async () => {
    const { session } = walkAway();
    await session.start();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(session.state().status).toBe("parked");
    await vi.advanceTimersByTimeAsync(600_000);
    expect(session.state().status).toBe("parked");
    // Resuming restarts it rather than re-parking against a stale stopwatch.
    session.resume();
    expect(session.state().status).toBe("live");
    await vi.advanceTimersByTimeAsync(119_000);
    expect(session.state().status).toBe("live");
  });

  it("0 disables it, and the slider applies AT ONCE", async () => {
    const { session } = walkAway({ parkAfterIdleSeconds: 0 });
    await session.start();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(session.state().status).toBe("live");

    // Shortening the window while an idle session sits there must park it —
    // waiting for the next activity would mean waiting for the thing that is
    // by definition not going to happen.
    session.setBehavior("parkAfterIdleSeconds", 5);
    expect(session.behavior().parkAfterIdleSeconds).toBe(5);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(session.state().status).toBe("parked");
  });

  it("a closed session leaves no timer running", async () => {
    const { session } = walkAway();
    await session.start();
    session.close();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(session.state().status).toBe("closed");
  });
});
