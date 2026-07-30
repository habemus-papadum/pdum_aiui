/**
 * The session engine, driven through a scripted transport (no network, no
 * key, no DOM) — the contracts that must hold whatever the transport:
 * event_id stamping, the completed-response tool gate, in-band tool errors,
 * live-surface reconciliation, park semantics, and the total ledger (unknown
 * vendor events retained as `raw`).
 */
import { describe, expect, it } from "vitest";
import { OracleSession } from "./session";
import type { KeySource, LedgerEntry, OracleTool, OracleTransport } from "./types";

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
    expect(rig.sent).toEqual([]);
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
        turnTuning: { threshold: 0.8, silence_duration_ms: 700 },
      },
      keySource: testKeys,
      transport: rig.transport,
    });
    await session.start();
    const opening = rig.sent[0] as { session: { audio: { input: { turn_detection: unknown } } } };
    expect(opening.session.audio.input.turn_detection).toEqual({
      type: "server_vad",
      threshold: 0.8,
      silence_duration_ms: 700,
    });
  });
});
