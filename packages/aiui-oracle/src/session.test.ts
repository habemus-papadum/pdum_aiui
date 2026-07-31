/**
 * The session engine, driven through a scripted transport (no network, no
 * key, no DOM) — the contracts that must hold whatever the transport:
 * event_id stamping, the completed-response tool gate, in-band tool errors,
 * live-surface reconciliation, park semantics, and the total ledger (unknown
 * vendor events retained as `raw`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OracleSession } from "./session";
import type { KeySource, LedgerEntry, OracleConfig, OracleTool, OracleTransport } from "./types";

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
    expect(session.state().usage).toEqual({
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
    expect(turnDetection(rig.sent[0])).toEqual({ type: "server_vad", threshold: 0.75 });
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
    expect(turnDetection(rig.sent[0])).toEqual({ type: "server_vad", threshold: 0.75 });
  });

  it("a reply that never SPOKE closes the window immediately — no echo to guard", async () => {
    const { session, rig } = guarded();
    await session.start();
    rig.sent.length = 0;
    rig.emit({ type: "response.created" });
    rig.emit({ type: "response.done", response: { id: "r1", status: "failed", output: [] } });
    expect(turnDetection(rig.sent[0])).toEqual({ type: "server_vad", threshold: 0.75 });
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
    await vi.advanceTimersByTimeAsync(14_000);
    expect(session.state().status).toBe("live");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(session.state().status).toBe("parked");
    // Park, not close: the mic is gated and the connection stands, so resuming
    // is one click and the conversation is still there.
    expect(rig.mic).toEqual([false]);
    const entry = session.ledger().at(-1) as Extract<LedgerEntry, { kind: "session" }>;
    expect(entry.phase).toBe("parked");
    expect(entry.detail).toContain("idle 15s");
  });

  it("says WHY it parked — walking away is news, parking it yourself is not", async () => {
    const { session } = walkAway();
    await session.start();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(session.state().parkedReason).toBe("idle");
    session.resume();
    expect(session.state().parkedReason).toBeUndefined();
    session.park();
    expect(session.state().parkedReason).toBe("manual");
  });

  it("activity restarts the clock; BOOKKEEPING does not", async () => {
    const { session, rig } = walkAway();
    await session.start();
    await vi.advanceTimersByTimeAsync(10_000);
    rig.emit({ type: "input_audio_buffer.speech_started" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(session.state().status).toBe("live");

    // A config ack is the session talking to itself. Counting it would keep an
    // abandoned session awake forever — the exact state this exists to end.
    await vi.advanceTimersByTimeAsync(4_000);
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
    await vi.advanceTimersByTimeAsync(14_000);
    session.sendText("look at this", { respond: false });
    await vi.advanceTimersByTimeAsync(14_000);
    expect(session.state().status).toBe("live");
  });

  it("a parked session stays parked — the clock does not run against itself", async () => {
    const { session } = walkAway();
    await session.start();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(session.state().status).toBe("parked");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(session.state().status).toBe("parked");
    // Resuming restarts it rather than re-parking against a stale stopwatch.
    session.resume();
    expect(session.state().status).toBe("live");
    await vi.advanceTimersByTimeAsync(14_000);
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
    await vi.advanceTimersByTimeAsync(60_000);
    expect(session.state().status).toBe("closed");
  });
});
