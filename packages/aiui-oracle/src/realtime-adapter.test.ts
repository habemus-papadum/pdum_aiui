/**
 * The oracle's Realtime adapter: the complete event derived from records —
 * the instructions bound, the rest as parameters — and verified exactly
 * against what left.
 */
import { snapshot } from "@habemus-papadum/aiui-prompts";
import {
  captureWire,
  consumerOperation,
  lowerOperation,
  parseOperation,
  parseWire,
  serializeOperation,
  serializeWire,
  verifyWire,
} from "@habemus-papadum/aiui-prompts/operations";
import { instructionsWithToolBrief, renderPrompt, toolSnapshot } from "@habemus-papadum/aiui-viz";
import { describe, expect, it } from "vitest";
import { instructionsPrompt } from "./prompt";
import {
  ORACLE_REALTIME_ADAPTER_IDENTITY,
  ORACLE_REALTIME_ADAPTERS,
  oracleRealtimeAdapter,
} from "./realtime-adapter";

const target = { kind: "custom", adapter: ORACLE_REALTIME_ADAPTER_IDENTITY, options: {} } as const;

/** What the session holds at send time, instructions aside. */
const sessionBlock = {
  audio: {
    input: {
      turn_detection: { type: "server_vad", interrupt_response: false },
      noise_reduction: { type: "near_field" },
    },
    output: { speed: 1 },
  },
  tools: [
    {
      type: "function",
      name: "set_freq",
      description: "Set the frequency.",
      parameters: { type: "object", properties: { value: { type: "number" } } },
    },
  ],
  max_output_tokens: 400,
};

function composed() {
  return renderPrompt(
    instructionsWithToolBrief(
      instructionsPrompt({ app: "A wave lab.", context: "On the main page." }),
      toolSnapshot([
        {
          ns: "app",
          brief: "One damped oscillator.",
          tools: [{ name: "set_freq", description: "Set the frequency.", kind: "write" }],
        },
      ]),
    ),
    { context: { session: { reason: "start", turns: 0, starts: 1 } } },
  );
}

describe("the oracle's Realtime adapter", () => {
  it("derives the session.update event: instructions from the binding, the rest from parameters", () => {
    const rendered = composed();
    const operation = consumerOperation({
      adapter: ORACLE_REALTIME_ADAPTER_IDENTITY,
      action: "session.update",
      bindings: [{ key: "instructions", content: rendered.record }],
      params: { session: sessionBlock, eventId: "evt_7" },
    });
    const prepared = lowerOperation(operation, target, {}, ORACLE_REALTIME_ADAPTERS);
    expect(prepared.payload).toEqual({
      type: "session.update",
      event_id: "evt_7",
      session: { type: "realtime", ...sessionBlock, instructions: rendered.text },
    });
    // The instructions are attributed as one copy of the record's text part.
    expect(prepared.mappings).toEqual([
      expect.objectContaining({
        path: ["session", "instructions"],
        binding: "instructions",
        record: rendered.record.fingerprint,
        relation: "copy",
        start: 0,
        end: rendered.text.length,
      }),
    ]);
    expect(prepared.decisions[0]).toMatchObject({
      kind: "oracle-realtime-session",
      action: "session.update",
      parameters: ["audio", "max_output_tokens", "tools"],
      instructions: true,
    });
  });

  it("derives the baked config for connect, model and voice included, with no envelope", () => {
    const rendered = composed();
    const baked = {
      ...sessionBlock,
      model: "gpt-realtime",
      audio: { ...sessionBlock.audio, output: { ...sessionBlock.audio.output, voice: "cedar" } },
    };
    const operation = consumerOperation({
      adapter: ORACLE_REALTIME_ADAPTER_IDENTITY,
      action: "connect",
      bindings: [{ key: "instructions", content: rendered.record }],
      params: { session: baked },
    });
    const prepared = lowerOperation(operation, target, {}, ORACLE_REALTIME_ADAPTERS);
    expect(prepared.payload).toEqual({ type: "realtime", ...baked, instructions: rendered.text });
    expect(prepared.mappings[0]?.path).toEqual(["instructions"]);
  });

  it("verifies the wire from plain JSON — the stored operation, the stored wire, this adapter", () => {
    const rendered = composed();
    const operation = consumerOperation({
      adapter: ORACLE_REALTIME_ADAPTER_IDENTITY,
      action: "session.update",
      bindings: [{ key: "instructions", content: rendered.record }],
      params: { session: sessionBlock, eventId: "evt_1" },
    });
    const prepared = lowerOperation(operation, target, {}, ORACLE_REALTIME_ADAPTERS);
    const wire = captureWire(prepared, prepared.payload, {
      capturedAt: "2026-10-10T08:00:00.000Z",
      transportId: "rtc_test",
    });
    // Round-trip through the ledger's JSON: no live objects survive.
    const storedOperation = parseOperation(serializeOperation(operation));
    const storedWire = parseWire(serializeWire(wire));
    expect(verifyWire(storedOperation, storedWire, ORACLE_REALTIME_ADAPTERS).equal).toBe(true);
    // A payload that differs anywhere — here the tools — no longer verifies.
    const tampered = captureWire(
      prepared,
      {
        ...(prepared.payload as Record<string, unknown>),
        session: { ...sessionBlock, type: "realtime", instructions: rendered.text, tools: [] },
      },
      { capturedAt: wire.capturedAt },
    );
    expect(verifyWire(storedOperation, tampered, ORACLE_REALTIME_ADAPTERS).equal).toBe(false);
  });

  it("lowers a tools-only update with no binding, and refuses what it does not declare", () => {
    const toolsOnly = consumerOperation({
      adapter: ORACLE_REALTIME_ADAPTER_IDENTITY,
      action: "session.update",
      bindings: [],
      params: { session: { tools: sessionBlock.tools }, eventId: "evt_2" },
    });
    const prepared = lowerOperation(toolsOnly, target, {}, ORACLE_REALTIME_ADAPTERS);
    expect(prepared.payload).toEqual({
      type: "session.update",
      event_id: "evt_2",
      session: { type: "realtime", tools: sessionBlock.tools },
    });
    expect(prepared.mappings).toEqual([]);
    expect(prepared.decisions[0]).toMatchObject({ instructions: false });

    const unknownAction = consumerOperation({
      adapter: ORACLE_REALTIME_ADAPTER_IDENTITY,
      action: "response.cancel",
      bindings: [],
      params: { session: {} },
    });
    expect(() => lowerOperation(unknownAction, target, {}, ORACLE_REALTIME_ADAPTERS)).toThrow(
      /does not declare action/,
    );
    const smuggled = consumerOperation({
      adapter: ORACLE_REALTIME_ADAPTER_IDENTITY,
      action: "session.update",
      bindings: [],
      params: { session: { instructions: "by hand" }, eventId: "evt_3" },
    });
    expect(() => lowerOperation(smuggled, target, {}, ORACLE_REALTIME_ADAPTERS)).toThrow(
      /never as a session parameter/,
    );
    const wrongKey = consumerOperation({
      adapter: ORACLE_REALTIME_ADAPTER_IDENTITY,
      action: "session.update",
      bindings: [{ key: "persona", content: snapshot("x") }],
      params: { session: {}, eventId: "evt_4" },
    });
    expect(() => lowerOperation(wrongKey, target, {}, ORACLE_REALTIME_ADAPTERS)).toThrow(
      /only binding/,
    );
    // A record naming a version nobody supplies is an explicit failure.
    expect(() => lowerOperation(toolsOnly, target, {}, [])).toThrow(/No adapter/);
    expect(oracleRealtimeAdapter.identity).toEqual({
      name: "aiui-oracle/realtime-session",
      version: "1",
    });
  });
});
