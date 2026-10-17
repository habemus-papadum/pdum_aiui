import { describe, expect, it } from "vitest";
import {
  appendEvent,
  appendKindOfAck,
  functionCallFromResponseEvent,
  functionCallOutputEvents,
  outputTextFromResponseEvent,
} from "./protocol";

describe("protocol", () => {
  it("maps ack types to kinds", () => {
    expect(appendKindOfAck("session.commentary.appended")).toBe("commentary");
    expect(appendKindOfAck("session.thinking.appended")).toBe("thinking");
    expect(appendKindOfAck("session.instructions.appended")).toBe("instructions");
    expect(appendKindOfAck("session.started")).toBeUndefined();
  });

  it("builds an append event with a null delegation id for session-wide", () => {
    expect(appendEvent("thinking", "e1", null, "fact")).toEqual({
      type: "session.thinking.append",
      event_id: "e1",
      delegation_id: null,
      content: "fact",
    });
  });

  it("reads a function call out of a nested Responses event", () => {
    const call = functionCallFromResponseEvent({
      type: "response.event",
      delegation_id: "item_1",
      event: {
        type: "response.output_item.done",
        item: {
          type: "function_call",
          call_id: "call_9",
          name: "set_freq",
          arguments: '{"value":5}',
        },
      },
    });
    expect(call).toEqual({ callId: "call_9", name: "set_freq", arguments: '{"value":5}' });
    expect(
      functionCallFromResponseEvent({
        type: "response.event",
        event: { type: "response.created" },
      }),
    ).toBeUndefined();
  });

  it("reads the output text of a completed response", () => {
    const text = outputTextFromResponseEvent({
      type: "response.event",
      delegation_id: "item_1",
      event: {
        type: "response.completed",
        response: {
          output: [{ type: "message", content: [{ type: "output_text", text: "Done." }] }],
        },
      },
    });
    expect(text).toBe("Done.");
  });

  it("answers a function call with an output item then a response.create", () => {
    const [output, go] = functionCallOutputEvents("call_9", { applied: 5 }, "c_3");
    expect(output).toMatchObject({
      type: "response.item.create",
      item: { type: "function_call_output", call_id: "call_9", output: '{"applied":5}' },
    });
    expect(go).toMatchObject({ type: "response.create" });
  });
});
