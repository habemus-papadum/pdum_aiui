/**
 * The host-neutral backend end to end: the broker's decisions, and the
 * relay carrying a delegation out to a server-side delegator and appends —
 * and a page-owned tool call — back, over a real socket on a random port.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { remoteDelegator } from "../delegators/remote.ts";
import type { DelegationRequest, Delegator } from "../types.ts";
import { runLiveServer, sessionOutcome } from "./backend.ts";

describe("sessionOutcome", () => {
  it("refuses keyless with the remedy", async () => {
    const outcome = await sessionOutcome({ sdp: "v=0" }, { resolveKey: () => undefined });
    expect(outcome.status).toBe(503);
    expect(String(outcome.body.error)).toContain("OPENAI_API_KEY");
  });

  it("rejects a body without an offer", async () => {
    const outcome = await sessionOutcome({ session: {} }, { resolveKey: () => "sk" });
    expect(outcome.status).toBe(400);
  });

  it("exchanges the offer with the vendor and answers { sessionId, sdp }", async () => {
    let posted: Record<string, unknown> | undefined;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      posted = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          session: { id: "live_1" },
          transport: { type: "webrtc", sdp: "v=answer" },
        }),
        { status: 201 },
      );
    }) as unknown as typeof fetch;
    const outcome = await sessionOutcome(
      { session: { model: "gpt-live-1" }, sdp: "v=offer" },
      { resolveKey: () => "sk", fetchImpl },
    );
    expect(outcome).toEqual({ status: 201, body: { sessionId: "live_1", sdp: "v=answer" } });
    expect(posted).toEqual({
      session: { model: "gpt-live-1" },
      transport: { type: "webrtc", sdp: "v=offer" },
    });
  });
});

describe("relay", () => {
  let server: Awaited<ReturnType<typeof runLiveServer>>;
  const seenOnServer: string[] = [];
  const toolResults: unknown[] = [];

  const serverDelegator: Delegator = {
    name: "server-test",
    describe: () => "the test backend",
    async handle(req: DelegationRequest) {
      seenOnServer.push(req.text);
      req.log("thinking");
      await req.note("quiet fact");
      const tool = req.tools[0];
      if (tool !== undefined) {
        const value = await tool.execute({ value: 5 });
        toolResults.push(value);
        await req.say(`applied ${JSON.stringify(value)}`);
        return undefined;
      }
      return "no tools here";
    },
  };

  beforeAll(async () => {
    server = await runLiveServer({
      port: 0,
      resolveKey: () => "sk",
      delegators: { test: () => serverDelegator },
      log: () => {},
    });
  });

  afterAll(async () => {
    await server.close();
  });

  it("answers /info", async () => {
    const response = await fetch(`http://127.0.0.1:${server.port}/live/info`);
    expect(await response.json()).toMatchObject({ ok: true, delegators: ["test"] });
  });

  it("carries a delegation out, appends and a page tool call back", async () => {
    const delegator = remoteDelegator({
      url: `ws://127.0.0.1:${server.port}/live/delegate`,
      delegator: "test",
      WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
    });
    const said: string[] = [];
    const noted: string[] = [];
    const logs: string[] = [];
    const executed: unknown[] = [];
    const req: DelegationRequest = {
      id: "item_1",
      text: "set it to five",
      transcript: { user: [], assistant: [] },
      tools: [
        {
          name: "set_freq",
          description: "set the frequency",
          parameters: { type: "object" },
          execute: (args) => {
            executed.push(args);
            return { applied: args.value };
          },
        },
      ],
      signal: new AbortController().signal,
      say: async (text) => {
        said.push(text);
      },
      note: async (text) => {
        noted.push(text);
      },
      steer: async () => {},
      log: (line) => {
        logs.push(line);
      },
    };
    const result = await delegator.handle(req);
    expect(result).toBeUndefined();
    expect(seenOnServer).toEqual(["set it to five"]);
    expect(executed).toEqual([{ value: 5 }]);
    expect(toolResults).toEqual([{ applied: 5 }]);
    expect(noted).toEqual(["quiet fact"]);
    expect(said).toEqual(['applied {"applied":5}']);
    expect(logs).toContain("thinking");
    expect(delegator.describe?.()).toContain("the test backend");
    delegator.dispose?.();
  });

  it("refuses an unknown delegator name", async () => {
    const delegator = remoteDelegator({
      url: `ws://127.0.0.1:${server.port}/live/delegate`,
      delegator: "nope",
      WebSocketImpl: WebSocket as unknown as typeof globalThis.WebSocket,
    });
    const req: DelegationRequest = {
      id: "item_2",
      text: "x",
      transcript: { user: [], assistant: [] },
      tools: [],
      signal: new AbortController().signal,
      say: async () => {},
      note: async () => {},
      steer: async () => {},
      log: () => {},
    };
    await expect(delegator.handle(req)).rejects.toThrow(/relay closed|unknown delegator/);
    delegator.dispose?.();
  });
});
