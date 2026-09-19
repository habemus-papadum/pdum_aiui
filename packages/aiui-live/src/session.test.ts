/**
 * The engine against a FAKE transport: every claim the widgets and the
 * delegators rely on — tickets, appends and their acks, request text from
 * the transcript, the hosted function-call loop, chunking, progress, idle
 * close and re-seed — pinned without a network.
 */

import { afterEach, describe, expect, it } from "vitest";
import { LiveSession, type LiveSessionOptions } from "./session";
import type {
  DelegationRequest,
  Delegator,
  LiveEvent,
  LiveTransport,
  TransportConnectOptions,
} from "./types";

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

/** A transport that records what was sent and lets the test play the server. */
function fakeTransport() {
  const sent: LiveEvent[] = [];
  let opts: TransportConnectOptions | undefined;
  let closed = 0;
  const transport: LiveTransport = {
    name: "fake",
    async connect(options) {
      opts = options;
      return {
        send: (event) => {
          sent.push(event);
          // The server echoes every append as an ack, unless the test intervenes.
          if (typeof event.type === "string" && event.type.endsWith(".append") && !holdAcks.value) {
            queueMicrotask(() =>
              options.onEvent({
                type: event.type.replace(/\.append$/, ".appended"),
                client_event_id: event.event_id,
                start_ms: 100,
                end_ms: 120,
              }),
            );
          }
          if (event.type === "session.close") {
            queueMicrotask(() =>
              options.onEvent({
                type: "session.closed",
                reason: "close_requested",
                usage: { seconds: 12 },
              }),
            );
          }
        },
        setMicEnabled: () => {},
        close: () => {
          closed += 1;
        },
        sessionId: "live_fake",
      };
    },
  };
  const holdAcks = { value: false };
  return {
    transport,
    sent,
    holdAcks,
    closedCount: () => closed,
    serve: (event: LiveEvent) => opts?.onEvent(event),
    started: () =>
      opts?.onEvent({
        type: "session.started",
        session: { id: "live_fake", expires_at: 1_900_000_000 },
      }),
    userSays: (text: string, startMs: number) =>
      opts?.onEvent({
        type: "session.input_transcript.delta",
        delta: text,
        start_ms: startMs,
        end_ms: startMs + 400,
      }),
    assistantSays: (text: string, startMs: number) =>
      opts?.onEvent({
        type: "session.output_transcript.delta",
        delta: text,
        start_ms: startMs,
        end_ms: startMs + 400,
      }),
    delegate: (id: string, target: "client" | "responses" = "client") =>
      opts?.onEvent({
        type: "session.delegation.created",
        offset_ms: 900,
        delegation: { id, type: "delegation", target },
      }),
    dropTransport: (reason: string) => opts?.onClose(reason),
  };
}

function session(
  fake: ReturnType<typeof fakeTransport>,
  extra: Partial<LiveSessionOptions> = {},
): LiveSession {
  return new LiveSession({ transport: fake.transport, idle: false, progress: false, ...extra });
}

async function startLive(fake: ReturnType<typeof fakeTransport>, live: LiveSession): Promise<void> {
  const starting = live.start();
  await tick();
  fake.started();
  await starting;
}

const sessions: LiveSession[] = [];
afterEach(async () => {
  for (const live of sessions.splice(0)) {
    await live.close();
  }
});

describe("LiveSession lifecycle", () => {
  it("starts on session.started and records the wire config", async () => {
    const fake = fakeTransport();
    const live = session(fake, { config: { instructions: { app: "wave app" }, voice: "cedar" } });
    sessions.push(live);
    await startLive(fake, live);
    expect(live.state().status).toBe("live");
    expect(live.state().sessionId).toBe("live_fake");
    expect(live.sessionConfig()).toMatchObject({
      model: "gpt-live-1",
      audio: { output: { voice: "cedar" } },
      delegation: { type: "client" },
    });
    expect(live.sessionConfig()?.instructions).toContain("wave app");
    expect(
      live
        .ledger()
        .some((entry) => entry.kind === "session" && entry.summary.startsWith("started")),
    ).toBe(true);
  });

  it("derives the voice model's Backend tools list from the tools and the brief", async () => {
    const fake = fakeTransport();
    const live = session(fake, { config: { instructions: { app: "wave app" } } });
    live.setTools(
      [{ name: "kick", description: "Add a phase impulse.", parameters: {}, execute: () => null }],
      { brief: "One damped oscillator. It has a trace." },
    );
    await startLive(fake, live);
    const text = live.sessionConfig()?.instructions ?? "";
    expect(text).toContain(
      "Backend tools:\n- App: One damped oscillator.\n- kick: Add a phase impulse.",
    );
    expect(live.currentBrief()).toBe("One damped oscillator. It has a trace.");
  });

  it("closes on request and reports the reason", async () => {
    const fake = fakeTransport();
    const live = session(fake);
    await startLive(fake, live);
    await live.close();
    expect(live.state().status).toBe("closed");
    expect(live.state().closeReason).toBe("close_requested");
    expect(live.state().seconds).toBe(12);
    expect(fake.closedCount()).toBe(1);
  });

  it("treats a dropped transport as connection_lost", async () => {
    const fake = fakeTransport();
    const live = session(fake);
    await startLive(fake, live);
    fake.dropTransport("boom");
    expect(live.state().status).toBe("closed");
    expect(live.state().closeReason).toContain("connection_lost");
  });

  it("rejects start on an error before session.started", async () => {
    const fake = fakeTransport();
    const live = session(fake);
    const starting = live.start();
    await tick();
    fake.serve({
      type: "error",
      error: { type: "invalid_request_error", code: "invalid_value", message: "bad model" },
    });
    await expect(starting).rejects.toThrow("bad model");
    expect(live.state().status).toBe("error");
  });
});

describe("delegation to a client delegator", () => {
  it("opens a task, hands the delegator the transcript since the last delegation, and records timings", async () => {
    const fake = fakeTransport();
    const seen: DelegationRequest[] = [];
    const delegator: Delegator = {
      name: "test",
      async handle(req) {
        seen.push(req);
        await req.note("checking");
        await req.say("Done. Five hertz.");
      },
    };
    const live = session(fake, { delegator });
    sessions.push(live);
    await startLive(fake, live);
    fake.userSays("set the", 0);
    fake.userSays(" frequency to five", 500);
    fake.delegate("item_1");
    await tick(5);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.text).toBe("set the frequency to five");
    const appends = fake.sent.filter((event) => event.type.endsWith(".append"));
    expect(appends.map((event) => [event.type, event.delegation_id, event.content])).toEqual([
      ["session.thinking.append", "item_1", "checking"],
      ["session.commentary.append", "item_1", "Done. Five hertz."],
    ]);
    fake.assistantSays("Done, five hertz", 2000);
    await tick(5);
    const task = live.task("item_1");
    expect(task?.status).toBe("done");
    expect(task?.backend).toBe("test");
    expect(task?.appends.every((append) => append.ackT !== undefined)).toBe(true);
    expect(task?.firstAppendT).toBeDefined();
    expect(task?.firstSpokenT).toBeDefined();
    expect(task?.doneAt).toBeDefined();
    expect(live.state().openTasks).toBe(0);
  });

  it("speaks a returned result when the delegator said nothing", async () => {
    const fake = fakeTransport();
    const live = session(fake, { delegator: { name: "quiet", handle: async () => "It is 0.8." } });
    sessions.push(live);
    await startLive(fake, live);
    fake.delegate("item_2");
    await tick(5);
    expect(
      fake.sent.some(
        (event) => event.type === "session.commentary.append" && event.content === "It is 0.8.",
      ),
    ).toBe(true);
    expect(live.task("item_2")?.result).toBe("It is 0.8.");
  });

  it("marks a throwing delegator failed and speaks the failure line", async () => {
    const fake = fakeTransport();
    const live = session(fake, {
      delegator: {
        name: "broken",
        handle: async () => {
          throw new Error("kaboom");
        },
      },
      failureText: "Sorry, no.",
    });
    sessions.push(live);
    await startLive(fake, live);
    fake.delegate("item_3");
    await tick(5);
    expect(live.task("item_3")).toMatchObject({ status: "failed", error: "kaboom" });
    expect(fake.sent.at(-1)).toMatchObject({
      type: "session.commentary.append",
      content: "Sorry, no.",
    });
  });

  it("aborts the delegator on cancel and drops its later appends", async () => {
    const fake = fakeTransport();
    let aborted = false;
    const live = session(fake, {
      delegator: {
        name: "slow",
        handle: (req) =>
          new Promise((_resolve, reject) => {
            req.signal.addEventListener("abort", () => {
              aborted = true;
              reject(new Error("cancelled"));
            });
          }),
      },
    });
    sessions.push(live);
    await startLive(fake, live);
    fake.delegate("item_4");
    await tick(2);
    live.cancelTask("item_4");
    await tick(2);
    expect(aborted).toBe(true);
    expect(live.task("item_4")?.status).toBe("cancelled");
    const receipt = await live.say("late", { delegationId: "item_4" });
    expect(receipt.error).toBe("task cancelled");
  });

  it("fails a delegation when no delegator is set", async () => {
    const fake = fakeTransport();
    const live = session(fake);
    sessions.push(live);
    await startLive(fake, live);
    fake.delegate("item_5");
    await tick(2);
    expect(live.task("item_5")).toMatchObject({ status: "failed", error: "no delegator" });
  });

  it("handles typed input as a local task with a null delegation id", async () => {
    const fake = fakeTransport();
    const live = session(fake, {
      delegator: { name: "echo", handle: async (req) => `heard ${req.text}` },
    });
    sessions.push(live);
    await startLive(fake, live);
    live.sendText("what is the damping");
    await tick(5);
    const append = fake.sent.find((event) => event.type === "session.commentary.append");
    expect(append).toMatchObject({ delegation_id: null, content: "heard what is the damping" });
    expect(live.tasks()[0]).toMatchObject({ target: "local", status: "done" });
  });
});

describe("appends", () => {
  it("settles on the ack with its timing, or on an error naming the event", async () => {
    const fake = fakeTransport();
    const live = session(fake);
    sessions.push(live);
    await startLive(fake, live);
    const ok = await live.say("hello");
    expect(ok).toMatchObject({ acked: true, startMs: 100, endMs: 120 });
    fake.holdAcks.value = true;
    const pending = live.note("x".repeat(10), { delegationId: null });
    await tick();
    const last = fake.sent.at(-1);
    fake.serve({
      type: "error",
      error: { code: "invalid_value", message: "too long", client_event_id: last?.event_id },
    });
    const bad = await pending;
    expect(bad.acked).toBe(false);
    expect(bad.error).toContain("too long");
  });

  it("chunks long text into several appends in order", async () => {
    const fake = fakeTransport();
    const live = session(fake);
    sessions.push(live);
    await startLive(fake, live);
    const long = "This is a sentence about the wave. ".repeat(80);
    await live.say(long);
    const appends = fake.sent.filter((event) => event.type === "session.commentary.append");
    expect(appends.length).toBeGreaterThan(1);
    expect(appends.map((event) => event.content).join(" ")).toBe(long.trim());
  });

  it("refuses to append when not live", async () => {
    const fake = fakeTransport();
    const live = session(fake);
    const receipt = await live.say("hello");
    expect(receipt.error).toBe("session is idle");
  });
});

describe("hosted Responses delegation", () => {
  it("runs the function-call loop and completes on the final response", async () => {
    const fake = fakeTransport();
    const applied: unknown[] = [];
    const live = session(fake, {
      config: { delegation: { type: "responses", responses: { model: "gpt-5.6-terra" } } },
      tools: [
        {
          name: "set_freq",
          description: "set",
          parameters: { type: "object", properties: { value: { type: "number" } } },
          execute: (args) => {
            applied.push(args);
            return { applied: args.value };
          },
        },
      ],
    });
    sessions.push(live);
    await startLive(fake, live);
    const wire = live.sessionConfig();
    expect(wire?.delegation).toMatchObject({
      type: "responses",
      responses: { tools: [{ type: "function", name: "set_freq" }] },
    });
    fake.userSays("five hertz please", 0);
    fake.serve({
      type: "session.delegation.created",
      offset_ms: 400,
      delegation: { id: "item_r", type: "delegation", target: "responses", response_id: "resp_1" },
    });
    fake.serve({
      type: "response.event",
      delegation_id: "item_r",
      event: {
        type: "response.output_item.done",
        item: {
          type: "function_call",
          call_id: "call_1",
          name: "set_freq",
          arguments: '{"value":5}',
        },
      },
    });
    await tick(2);
    expect(applied).toEqual([{ value: 5 }]);
    const replies = fake.sent.filter(
      (event) => event.type === "response.item.create" || event.type === "response.create",
    );
    expect(replies.map((event) => event.type)).toEqual(["response.item.create", "response.create"]);
    expect(replies[0]).toMatchObject({
      item: { type: "function_call_output", call_id: "call_1", output: '{"applied":5}' },
    });
    fake.serve({
      type: "response.event",
      delegation_id: "item_r",
      event: {
        type: "response.completed",
        response: {
          output: [{ type: "message", content: [{ type: "output_text", text: "Set to 5." }] }],
        },
      },
    });
    expect(live.task("item_r")).toMatchObject({
      status: "done",
      result: "Set to 5.",
      target: "responses",
      responseId: "resp_1",
    });
  });

  it("sends typed input as a message item in responses mode", async () => {
    const fake = fakeTransport();
    const live = session(fake, {
      config: { delegation: { type: "responses", responses: { model: "m" } } },
    });
    sessions.push(live);
    await startLive(fake, live);
    live.sendText("hello backend");
    expect(fake.sent.slice(-2).map((event) => event.type)).toEqual([
      "response.item.create",
      "response.create",
    ]);
    expect(fake.sent.at(-2)).toMatchObject({
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hello backend" }],
      },
    });
  });
});

describe("progress, idle, re-seed", () => {
  it("speaks a progress line when a task stays quiet", async () => {
    const fake = fakeTransport();
    const live = session(fake, {
      delegator: {
        name: "slow",
        handle: (req) =>
          new Promise((resolve) => req.signal.addEventListener("abort", () => resolve(undefined))),
      },
      progress: { afterMs: 30, text: "Still on it." },
    });
    sessions.push(live);
    await startLive(fake, live);
    fake.delegate("item_p");
    await tick(60);
    expect(
      fake.sent.some(
        (event) =>
          event.type === "session.commentary.append" &&
          event.content === "Still on it." &&
          event.delegation_id === "item_p",
      ),
    ).toBe(true);
    live.cancelTask("item_p");
  });

  it("closes when idle and re-seeds the next start from the transcript", async () => {
    const fake = fakeTransport();
    const live = session(fake, { idle: { closeAfterSeconds: 0.03 } });
    await startLive(fake, live);
    fake.userSays("hello there", 0);
    fake.assistantSays("hi", 500);
    await tick(80);
    expect(live.state().status).toBe("closed");
    expect(live.state().closeReason).toBe("idle");
    const seed = live.reseedInput();
    expect(seed?.[0]).toMatchObject({ role: "developer" });
    expect(seed?.slice(1)).toEqual([
      { role: "user", content: [{ type: "input_text", text: "hello there" }] },
      { role: "assistant", content: [{ type: "output_text", text: "hi" }] },
    ]);
    const fake2 = fakeTransport();
    const again = session(fake2, { idle: false });
    // Same object re-seeds: start a second time on the same session instead.
    const starting = live.start();
    await tick();
    fake.started();
    await starting;
    expect(live.sessionConfig()?.input?.length).toBe(3);
    expect(live.state().starts).toBe(2);
    await live.close();
    void again;
  });
});
