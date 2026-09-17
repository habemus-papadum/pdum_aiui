import { describe, expect, it } from "vitest";
import type { DelegationRequest } from "../types";
import { requestMessage, responsesDelegator } from "./responses";

function request(
  text: string,
  tools: DelegationRequest["tools"] = [],
): DelegationRequest & { said: string[]; logs: string[] } {
  const said: string[] = [];
  const logs: string[] = [];
  return {
    id: "item_x",
    text,
    transcript: { user: [{ text, startMs: 0, endMs: 400, t: 0, tEnd: 0 }], assistant: [] },
    tools,
    signal: new AbortController().signal,
    say: async (line) => {
      said.push(line);
    },
    note: async () => {},
    steer: async () => {},
    log: (line) => {
      logs.push(line);
    },
    said,
    logs,
  };
}

describe("responsesDelegator", () => {
  it("runs the tool loop statelessly and returns the final text", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      const input = body.input as unknown[];
      const hasOutput = input.some(
        (item) => (item as { type?: string }).type === "function_call_output",
      );
      const output = hasOutput
        ? [
            {
              type: "message",
              content: [{ type: "output_text", text: "Frequency is now 5 hertz." }],
            },
          ]
        : [
            {
              type: "function_call",
              call_id: "call_1",
              name: "set_freq",
              arguments: '{"value":5}',
            },
          ];
      return new Response(
        JSON.stringify({ id: "resp", output, usage: { input_tokens: 10, output_tokens: 2 } }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const applied: unknown[] = [];
    const req = request("set the frequency to five", [
      {
        name: "set_freq",
        description: "set",
        parameters: {},
        execute: (args) => {
          applied.push(args);
          return { applied: 5 };
        },
      },
    ]);
    const delegator = responsesDelegator({
      key: "sk-test",
      model: "test-model",
      fetchImpl,
      effort: "low",
    });
    const result = await delegator.handle(req);
    expect(result).toBe("Frequency is now 5 hertz.");
    expect(applied).toEqual([{ value: 5 }]);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toMatchObject({
      model: "test-model",
      store: false,
      reasoning: { effort: "low" },
      tools: [{ type: "function", name: "set_freq" }],
    });
    const second = bodies[1]?.input as Array<{ type?: string }>;
    expect(second.map((item) => item.type)).toEqual([
      undefined,
      "function_call",
      "function_call_output",
    ]);
    expect(req.logs.some((line) => line.startsWith("call set_freq"))).toBe(true);
  });

  it("fails loudly without a key", async () => {
    const delegator = responsesDelegator({ key: () => undefined });
    await expect(delegator.handle(request("hi"))).rejects.toThrow(/no OpenAI key/);
  });

  it("frames the request with recent context", () => {
    const text = requestMessage(request("why is it jagged"), 4);
    expect(text).toContain("Recent conversation");
    expect(text).toContain("user: why is it jagged");
    expect(text).toContain("Request (delegation item_x): why is it jagged");
  });
});
