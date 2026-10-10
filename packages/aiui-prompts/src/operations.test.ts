import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalJson, type JsonObject } from "./json.ts";
import { Choice, Group, Image, PromptError } from "./model.ts";
import {
  captureWire,
  channelPush,
  lowerOperation,
  parseOperation,
  parseWire,
  responseOperation,
  serializeOperation,
  serializeWire,
  sessionOperation,
  verifyWire,
} from "./operations.ts";
import { semanticFingerprint, snapshot, withRecordOptions } from "./record.ts";
import { toolSnapshot } from "./tools-data.ts";

const instruction = () => snapshot("Use scientific notation.");
const media = () =>
  snapshot(
    Group({
      children: [
        "Inspect ",
        Image({ asset: { id: "plot", digest: "sha256:plot-v1", alt: "Energy plot" } }),
        " carefully.",
      ],
    }),
  );
const urlAssets = {
  plot: { kind: "url" as const, value: "https://example.test/plot.png", digest: "sha256:plot-v1" },
};
const signed = (input: unknown) => {
  const { fingerprint: _fingerprint, ...body } = JSON.parse(JSON.stringify(input));
  return { ...body, fingerprint: semanticFingerprint(body) };
};
function code(action: () => unknown, expected: string) {
  try {
    action();
    throw new Error("Expected failure");
  } catch (error) {
    expect(error).toBeInstanceOf(PromptError);
    expect((error as PromptError).diagnostic.code).toBe(expected);
  }
}

describe("semantic operation storage", () => {
  it("JSON round-trips each consumer kind without emitted content and deduplicates reused records", () => {
    const value = instruction();
    const operations = [
      sessionOperation(value, { action: "replace-instructions", sessionId: "s1", eventId: "e1" }),
      channelPush(value),
      responseOperation({
        instructions: value,
        messages: [
          { key: "one", role: "user", content: value },
          { key: "two", role: "assistant", content: value },
        ],
      }),
    ];
    for (const operation of operations) {
      expect(parseOperation(serializeOperation(operation))).toEqual(operation);
      expect(Object.keys(operation.records)).toEqual([value.fingerprint]);
      expect(serializeOperation(operation)).not.toContain("mappings");
      expect(serializeOperation(operation)).not.toContain("payload");
    }
  });
  it("owns metadata and opaque history while never freezing callers", () => {
    const meta = { kind: "notice" };
    const history = {
      kind: "provider-items" as const,
      protocol: "openai-responses/1" as const,
      items: [{ type: "reasoning", encrypted_content: "opaque", summary: [] }],
    };
    const channel = channelPush(instruction(), meta);
    const response = responseOperation({ input: instruction(), history });
    meta.kind = "changed";
    history.items[0].encrypted_content = "changed";
    expect(Object.isFrozen(meta)).toBe(false);
    expect(Object.isFrozen(history.items)).toBe(false);
    expect(channel.operation).toMatchObject({ meta: { kind: "notice" } });
    expect(response.operation).toMatchObject({
      history: { items: [{ encrypted_content: "opaque" }] },
    });
  });
  it("fails malformed persisted shapes before reading nested fields", () => {
    const operation = responseOperation({ input: instruction() });
    const body = operation.operation;
    for (const messages of [null, {}, [], [null], [{ key: "x", role: "user" }]])
      code(
        () => parseOperation(signed({ ...operation, operation: { ...body, messages } })),
        messages && Array.isArray(messages) && messages.length && messages[0]
          ? "RECORD_REFERENCE"
          : "MESSAGES",
      );
    code(
      () =>
        parseOperation(
          signed({
            ...operation,
            operation: {
              ...body,
              history: { kind: "remote", provider: "openai", reference: null },
            },
          }),
        ),
      "HISTORY_PROTOCOL",
    );
    code(
      () => parseOperation(signed({ ...operation, operation: { ...body, qualifyTools: "yes" } })),
      "MESSAGES",
    );
    code(
      () => parseOperation(signed({ ...operation, operation: { ...body, outputSchema: [] } })),
      "OUTPUT_SCHEMA",
    );
    code(() => parseOperation("{bad-json"), "OPERATION_JSON");
  });
  it("rejects unknown fields, unsupported versions, broken references, and tampering", () => {
    const operation = channelPush(instruction());
    code(() => parseOperation({ ...operation, schemaVersion: 2 }), "OPERATION_SCHEMA");
    code(() => parseOperation(signed({ ...operation, unexpected: true })), "OPERATION_SHAPE");
    code(
      () =>
        parseOperation(
          signed({ ...operation, operation: { ...operation.operation, unexpected: true } }),
        ),
      "CHANNEL_META",
    );
    code(() => parseOperation(signed({ ...operation, records: {} })), "RECORD_REFERENCE");
    const other = snapshot("unused");
    code(
      () =>
        parseOperation(
          signed({ ...operation, records: { ...operation.records, [other.fingerprint]: other } }),
        ),
      "RECORD_REFERENCE",
    );
    code(
      () =>
        parseOperation({
          ...operation,
          operation: { ...operation.operation, meta: { kind: "changed" } },
        }),
      "OPERATION_FINGERPRINT",
    );
  });
  it("validates constructor inputs and accessors before returning any storable operation", () => {
    code(
      () =>
        sessionOperation(instruction(), {
          action: "unknown",
          sessionId: "s",
          eventId: "e",
        } as never),
      "SESSION_OPERATION",
    );
    code(
      () => sessionOperation(instruction(), { action: "input", sessionId: "", eventId: "e" }),
      "SESSION_OPERATION",
    );
    code(() => channelPush(instruction(), [] as never), "CHANNEL_META");
    code(
      () =>
        responseOperation({
          input: instruction(),
          history: {
            kind: "remote",
            provider: "openai",
            reference: { kind: "conversation", id: "" },
          },
        }),
      "HISTORY_PROTOCOL",
    );
    code(
      () =>
        responseOperation({
          messages: [
            { key: "same", role: "user", content: instruction() },
            { key: "same", role: "user", content: instruction() },
          ],
        }),
      "MESSAGES",
    );
    let accessed = false;
    const bad = {
      get input() {
        accessed = true;
        return instruction();
      },
    };
    code(() => responseOperation(bad), "MESSAGES");
    expect(accessed).toBe(false);
  });
});

describe("session consumers", () => {
  it("lowers Realtime instruction replacement, per-response instructions, and multimodal input separately", () => {
    const replace = sessionOperation(instruction(), {
      action: "replace-instructions",
      sessionId: "s",
      eventId: "e1",
    });
    expect(lowerOperation(replace, { kind: "openai-realtime/1" }).payload).toEqual({
      type: "session.update",
      event_id: "e1",
      session: { type: "realtime", instructions: "Use scientific notation." },
    });
    const respond = sessionOperation(instruction(), {
      action: "respond",
      sessionId: "s",
      eventId: "e2",
    });
    expect(lowerOperation(respond, { kind: "openai-realtime/1" }).payload).toEqual({
      type: "response.create",
      event_id: "e2",
      response: { instructions: "Use scientific notation." },
    });
    const input = sessionOperation(media(), { action: "input", sessionId: "s", eventId: "e3" });
    const dataAssets = { plot: { ...urlAssets.plot, value: "data:image/png;base64,AQID" } };
    expect(lowerOperation(input, { kind: "openai-realtime/1" }, dataAssets).payload).toEqual({
      type: "conversation.item.create",
      event_id: "e3",
      item: {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "Inspect " },
          { type: "input_image", image_url: "data:image/png;base64,AQID" },
          { type: "input_text", text: " carefully." },
        ],
      },
    });
    code(() => lowerOperation(input, { kind: "openai-realtime/1" }, urlAssets), "ASSET_POLICY");
  });
  it("keeps appends explicit and refuses to invent unsupported session semantics", () => {
    const append = sessionOperation(instruction(), {
      action: "append-commentary",
      sessionId: "s",
      eventId: "e",
      delegationId: "d",
    });
    expect(lowerOperation(append, { kind: "live-session/1" }).payload).toEqual({
      type: "session.commentary.append",
      event_id: "e",
      delegation_id: "d",
      content: "Use scientific notation.",
    });
    code(() => lowerOperation(append, { kind: "openai-realtime/1" }), "SESSION_CAPABILITY");
    code(
      () =>
        lowerOperation(
          sessionOperation(instruction(), {
            action: "replace-instructions",
            sessionId: "s",
            eventId: "e",
          }),
          { kind: "live-session/1" },
        ),
      "SESSION_CAPABILITY",
    );
    code(
      () =>
        lowerOperation(
          sessionOperation(media(), {
            action: "replace-instructions",
            sessionId: "s",
            eventId: "e",
          }),
          { kind: "openai-realtime/1" },
          urlAssets,
        ),
      "TEXT_ONLY",
    );
  });
});

describe("channel and Responses consumers", () => {
  it("derives a textual asset path with exact output mappings for channel push", () => {
    const operation = channelPush(media(), { kind: "image-context" });
    const delivery = lowerOperation(
      operation,
      { kind: "claude-channel/1" },
      {
        plot: {
          kind: "path",
          value: "/tmp/plot.png",
          label: "screenshot",
          digest: "sha256:plot-v1",
        },
      },
    );
    expect(delivery.payload).toEqual({
      method: "notifications/claude/channel",
      params: {
        content: "Inspect [screenshot located at /tmp/plot.png] carefully.",
        meta: { kind: "image-context" },
      },
    });
    expect(delivery.decisions).toContainEqual(
      expect.objectContaining({ kind: "asset-reference", policy: "path", asset: "plot" }),
    );
    expect(delivery.mappings.map((mapping) => mapping.relation)).toEqual([
      "copy",
      "asset-reference",
      "copy",
    ]);
    expect(delivery.mappings[1].start).toBe(8);
    expect(delivery.mappings[2].start).toBe(delivery.mappings[1].end);
    const caption = lowerOperation(
      operation,
      { kind: "claude-channel/1" },
      { plot: { kind: "caption", value: "[Energy]\nplot", digest: "sha256:plot-v1" } },
    );
    expect((caption.payload as JsonObject).params).toMatchObject({
      content: "Inspect [Energy]\nplot carefully.",
    });
  });
  it("preserves opaque replay items and projects current roles, instructions, and assets independently", () => {
    const replay = { type: "reasoning", id: "rs_1", encrypted_content: "opaque", summary: [] };
    const operation = responseOperation({
      instructions: instruction(),
      messages: [
        { key: "initial", role: "user", content: media() },
        { key: "example", role: "assistant", content: snapshot("Example answer.") },
        { key: "question", role: "user", content: snapshot("Now explain.") },
      ],
      history: { kind: "provider-items", protocol: "openai-responses/1", items: [replay] },
    });
    const delivery = lowerOperation(
      operation,
      { kind: "openai-responses/1", model: "test-model" },
      urlAssets,
    );
    const payload = delivery.payload as JsonObject;
    const input = payload.input as readonly JsonObject[];
    expect(input[0]).toEqual(replay);
    expect(input.slice(1).map((item) => item.role)).toEqual(["user", "assistant", "user"]);
    expect(input[2].content).toBe("Example answer.");
    expect(payload.instructions).toBe("Use scientific notation.");
    expect(delivery.mappings.find((mapping) => mapping.binding === "initial")?.path).toEqual([
      "input",
      1,
      "content",
      0,
      "text",
    ]);
    expect(delivery.status).toBe("prepared-not-sent");
  });
  it("leaves remote history untouched when current prompt selection changes", () => {
    const record = snapshot(
      Choice({ name: "background", children: "long current", short: "short current" }),
    );
    const history = {
      kind: "remote" as const,
      provider: "openai" as const,
      reference: { kind: "conversation" as const, id: "conv_1" },
    };
    const first = lowerOperation(responseOperation({ input: record, history }), {
      kind: "openai-responses/1",
      model: "test-model",
    });
    const second = lowerOperation(
      responseOperation({
        input: withRecordOptions(record, { selection: { background: "short" } }),
        history,
      }),
      { kind: "openai-responses/1", model: "test-model" },
    );
    expect((first.payload as JsonObject).conversation).toBe("conv_1");
    expect((second.payload as JsonObject).conversation).toBe("conv_1");
    expect(canonicalJson(second.payload)).toContain("short current");
    expect(canonicalJson(second.payload)).not.toContain("long current");
  });
  it("links tool schemas to their immutable declaration snapshot and excludes usage on the wire", () => {
    const tools = toolSnapshot([
      {
        ns: "app",
        tools: [
          {
            name: "read",
            description: "Read state.",
            usage: "Call with an ID.",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      },
    ]);
    const delivery = lowerOperation(
      responseOperation({ input: instruction(), tools, outputSchema: { type: "object" } }),
      { kind: "openai-responses/1", model: "test-model" },
    );
    expect(canonicalJson(delivery.payload)).not.toContain("Call with an ID.");
    expect((delivery.payload as JsonObject).tools).toEqual([
      {
        type: "function",
        name: "read",
        description: "Read state.",
        parameters: { type: "object", properties: {} },
        strict: false,
      },
    ]);
    expect(delivery.mappings.find((mapping) => mapping.binding === "tools")?.origin?.snapshot).toBe(
      tools.fingerprint,
    );
  });
  it("rejects unsupported targets, asset policies, missing representations, stale digests, and assistant images", () => {
    const operation = responseOperation({ input: media() });
    code(
      () =>
        lowerOperation(operation, { kind: "openai-responses/2", model: "x" } as never, urlAssets),
      "TARGET_KIND",
    );
    code(() => lowerOperation(operation, { kind: "claude-channel/1" }, urlAssets), "TARGET_KIND");
    code(
      () => lowerOperation(operation, { kind: "openai-responses/1", model: "x" }),
      "ASSET_BINDING",
    );
    code(
      () =>
        lowerOperation(
          operation,
          { kind: "openai-responses/1", model: "x" },
          { plot: { kind: "url", value: "https://example.test/plot.png", digest: "old" } },
        ),
      "ASSET_REVISION",
    );
    code(
      () =>
        lowerOperation(
          operation,
          { kind: "openai-responses/1", model: "x" },
          { plot: { kind: "path", value: "/tmp/plot.png", digest: "sha256:plot-v1" } },
        ),
      "ASSET_POLICY",
    );
    code(
      () =>
        lowerOperation(
          responseOperation({ messages: [{ key: "a", role: "assistant", content: media() }] }),
          { kind: "openai-responses/1", model: "x" },
          urlAssets,
        ),
      "ASSISTANT_IMAGE",
    );
  });
});

describe("captured wire replay", () => {
  it("round-trips actual transport payload separately and detects renderer or transport drift", () => {
    const operation = responseOperation({ input: instruction() });
    const prepared = lowerOperation(operation, { kind: "openai-responses/1", model: "test-model" });
    const wire = captureWire(prepared, prepared.payload, {
      capturedAt: "2026-10-09T12:00:00.000Z",
      transportId: "request-1",
    });
    expect(parseWire(serializeWire(wire))).toEqual(wire);
    expect(verifyWire(parseOperation(serializeOperation(operation)), wire).equal).toBe(true);
    const drift = captureWire(
      prepared,
      { ...(prepared.payload as JsonObject), model: "unexpected-model" },
      { capturedAt: "2026-10-09T12:00:00.000Z" },
    );
    expect(verifyWire(operation, drift)).toMatchObject({
      equal: false,
      actual: { model: "unexpected-model" },
    });
    expect(wire.status).toBe("captured");
    expect(serializeOperation(operation)).not.toContain("capturedAt");
  });
  it("rejects unsupported lowerer/schema, malformed wire fields, and mismatched operation references", () => {
    const operation = channelPush(instruction());
    const prepared = lowerOperation(operation, { kind: "claude-channel/1" });
    const wire = captureWire(prepared, prepared.payload, { capturedAt: "2026-10-09T12:00:00Z" });
    code(() => parseWire({ ...wire, schemaVersion: 2 }), "WIRE_VERSION");
    code(() => parseWire({ ...wire, lowerer: "aiui-prompts-delivery/9.0.0" }), "WIRE_VERSION");
    code(() => parseWire({ ...wire, status: "prepared-not-sent" }), "WIRE_SHAPE");
    code(() => parseWire({ ...wire, unknown: "field" }), "WIRE_SHAPE");
    code(
      () => parseWire({ ...wire, target: { kind: "claude-channel/1", model: "unexpected" } }),
      "TARGET_KIND",
    );
    code(() => parseWire({ ...wire, capturedAt: "yesterday" }), "CAPTURE_TIME");
    code(() => verifyWire(channelPush(snapshot("other")), wire), "WIRE_OPERATION");
    code(
      () =>
        captureWire({ ...prepared, status: "captured" } as never, prepared.payload, {
          capturedAt: "2026-10-09T12:00:00Z",
        }),
      "DELIVERY_SHAPE",
    );
  });
  it("never invokes accessors in wire data", () => {
    let called = false;
    code(
      () =>
        parseWire({
          get kind() {
            called = true;
            return "aiui.prompt.wire";
          },
        }),
      "WIRE_JSON",
    );
    expect(called).toBe(false);
  });
});

describe("persisted schema-v1 delivery contract", () => {
  it("reads committed operation and wire records and rederives their exact channel payload", () => {
    // These fixtures are retained ledger examples, never regenerated by the test.
    const operation = parseOperation(
      readFileSync(new URL("../test/fixtures/operation-v1.json", import.meta.url), "utf8"),
    );
    const wire = parseWire(
      readFileSync(new URL("../test/fixtures/wire-v1.json", import.meta.url), "utf8"),
    );
    expect(operation.schemaVersion).toBe(1);
    expect(wire.schemaVersion).toBe(1);
    expect(wire.lowerer).toBe("aiui-prompts-delivery/1.0.0");
    expect(wire.operation).toBe(operation.fingerprint);
    const expected = {
      method: "notifications/claude/channel",
      params: {
        content:
          "Welcome.\n\nBrief background.\n\n$$\n\\hat{H}\\psi=E\\psi\n$$\n\n[plot located at ./fixtures/energy-plot.png]",
        meta: { kind: "science-context" },
      },
    };
    expect(wire.payload).toEqual(expected);
    expect(lowerOperation(operation, wire.target, wire.assets).payload).toEqual(expected);
    expect(verifyWire(operation, wire)).toEqual({ equal: true, expected, actual: expected });
  });
});

it("requires own asset bindings for IDs matching Object.prototype properties", () => {
  for (const id of ["constructor", "toString", "__proto__"]) {
    const operation = channelPush(snapshot(Image({ asset: { id } })));
    code(() => lowerOperation(operation, { kind: "claude-channel/1" }, {}), "ASSET_BINDING");
    const delivery = lowerOperation(
      operation,
      { kind: "claude-channel/1" },
      { [id]: { kind: "path", value: "./plot.png" } },
    );
    expect(delivery.payload).toEqual({
      method: "notifications/claude/channel",
      params: { content: "[image located at ./plot.png]", meta: { kind: "prompt" } },
    });
  }
});
