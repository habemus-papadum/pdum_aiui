import { snapshot } from "@habemus-papadum/aiui-prompts";
import {
  type ConsumerAdapter,
  captureWire,
  channelPush,
  consumerOperation,
  lowerOperation,
  responseOperation,
} from "@habemus-papadum/aiui-prompts/operations";
import { describe, expect, it } from "vitest";
import { InspectorController } from "./controller.ts";
import { loadInspection } from "./history.ts";

describe("historical inspection without an author application", () => {
  it("keeps instructions distinct from a message whose user-chosen key is instructions", () => {
    const operation = responseOperation({
      instructions: snapshot("System guidance"),
      messages: [{ key: "instructions", role: "user", content: snapshot("Current request") }],
    });
    const controller = new InspectorController(operation);
    expect(controller.document?.bindings.map((item) => item.key)).toEqual([
      "instructions",
      "message:instructions",
    ]);
    expect(controller.selectRecord("message:instructions")).toBe(true);
    expect(controller.compiled?.parts).toMatchObject([{ text: "Current request" }]);
  });
  it("loads a JSON round trip and switches operation bindings without exposing history as a prompt", () => {
    const instructions = snapshot("Analyze units.");
    const input = snapshot("Compare the measurements.");
    const operation = responseOperation({
      instructions,
      input,
      history: {
        kind: "provider-items",
        protocol: "openai-responses/1",
        items: [{ type: "message", content: "Opaque retained history" }],
      },
    });
    const controller = new InspectorController(JSON.stringify(operation));
    expect(controller.error).toBeNull();
    expect(controller.document?.bindings.map((item) => item.key)).toEqual([
      "instructions",
      "message:input",
    ]);
    expect(controller.record?.fingerprint).toBe(instructions.fingerprint);
    expect(controller.selectRecord("message:input")).toBe(true);
    expect(controller.record?.fingerprint).toBe(input.fingerprint);
    expect(controller.compiled?.parts).toMatchObject([{ text: "Compare the measurements." }]);
    expect(controller.selectRecord("history")).toBe(false);
    controller.dispose();
    expect(controller.selectRecord("instructions")).toBe(false);
  });

  it("distinguishes actual captured output from re-derivation and rejects the wrong operation", () => {
    const operation = channelPush(snapshot("Recorded content"));
    const delivery = lowerOperation(operation, { kind: "claude-channel/1" });
    const wire = captureWire(delivery, delivery.payload, { capturedAt: "2026-10-10T12:00:00Z" });
    const loaded = loadInspection(JSON.stringify(wire), { operation: JSON.stringify(operation) });
    expect(loaded.verification).toEqual({ status: "equal" });
    expect(loaded.wire?.payload).toEqual(delivery.payload);
    expect(loaded.delivery?.mappings).toEqual(delivery.mappings);
    const changed = captureWire(
      delivery,
      { content: "Changed by transport" },
      {
        capturedAt: "2026-10-10T12:00:00Z",
      },
    );
    expect(loadInspection(changed, { operation }).verification).toEqual({ status: "different" });
    expect(() => loadInspection(wire)).toThrow(/referenced semantic operation/);
    expect(() => loadInspection(wire, { operation: channelPush(snapshot("Other")) })).toThrow(
      /different semantic operation/,
    );
  });

  it("re-derives prepared caches instead of trusting their saved contribution mappings", () => {
    const operation = channelPush(snapshot("Keep the source map exact"));
    const delivery = lowerOperation(operation, { kind: "claude-channel/1" });
    expect(loadInspection(delivery, { operation }).verification).toEqual({ status: "equal" });
    const changed = { ...delivery, mappings: [{ wrong: "cache" }] };
    const loaded = loadInspection(changed, { operation });
    expect(loaded.verification).toEqual({ status: "different" });
    expect(loaded.prepared?.mappings).toEqual(changed.mappings);
    expect(loaded.delivery?.mappings).toEqual(delivery.mappings);
    expect(loaded.wire).toBeUndefined();
  });

  it("keeps wire payloads inspectable when an exact consumer adapter is unavailable", () => {
    const adapter: ConsumerAdapter = {
      identity: { name: "archived-example", version: "1" },
      capabilities: { actions: ["ping"], content: [], assets: [] },
      lower: () => ({ payload: { event: "ping" }, mappings: [], decisions: [] }),
    };
    const operation = consumerOperation({
      adapter: adapter.identity,
      action: "ping",
      bindings: [],
    });
    const target = { kind: "custom" as const, adapter: adapter.identity, options: {} };
    const delivery = lowerOperation(operation, target, {}, [adapter]);
    const wire = captureWire(delivery, delivery.payload, { capturedAt: "2026-10-10T12:00:00Z" });
    const controller = new InspectorController(wire, { operation });
    expect(controller.error).toBeNull();
    expect(controller.document?.bindings).toEqual([]);
    expect(controller.document?.wire?.payload).toEqual({ event: "ping" });
    expect(controller.document?.verification).toMatchObject({ status: "unavailable" });
    expect(controller.compiled).toBeNull();
    expect(loadInspection(wire, { operation, adapters: [adapter] }).verification).toEqual({
      status: "equal",
    });
  });

  it("retains the last good operation and binding when an import fails, without invoking getters", () => {
    const operation = responseOperation({
      instructions: snapshot("Instructions"),
      input: snapshot("Input"),
    });
    const controller = new InspectorController(operation);
    controller.selectRecord("message:input");
    const before = controller.compiled;
    let invoked = false;
    expect(
      controller.load({
        get kind() {
          invoked = true;
          return "aiui.prompt";
        },
      }),
    ).toBe(false);
    expect(invoked).toBe(false);
    expect(controller.compiled).toBe(before);
    expect(controller.document?.operation).toEqual(operation);
    expect(controller.recordKey).toBe("message:input");
    expect(controller.load({ ...operation, schemaVersion: 987 })).toBe(false);
    expect(controller.error).toMatch(/schema|version/i);
    expect(controller.compiled).toBe(before);
  });
});
