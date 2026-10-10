import { describe, expect, it } from "vitest";
import type { JsonValue } from "./json.ts";
import { Choice, Group, Image, PromptError } from "./model.ts";
import {
  type ConsumerAdapter,
  type ConsumerAdapterResult,
  captureWire,
  consumerOperation,
  type DeliveryMap,
  lowerOperation,
  parseOperation,
  parseWire,
  serializeOperation,
  serializeWire,
  verifyWire,
} from "./operations.ts";
import { semanticFingerprint, snapshot } from "./record.ts";

const identity = { name: "test/socket-events", version: "1.2.0" } as const;
const target = { kind: "custom", adapter: identity, options: { channel: "analysis" } } as const;
const textCapabilities = { actions: ["append", "flush"], content: ["text"], assets: [] } as const;

/** A consumer implementation: the toolkit has no knowledge of this socket's event schema. */
const socketAdapter: ConsumerAdapter = {
  identity,
  capabilities: textCapabilities,
  lower({ operation, options, bindings }) {
    if (operation.action !== "append" && operation.action !== "flush")
      throw new PromptError("SOCKET_CAPABILITY", "This version supports append and flush only.");
    const mappings: DeliveryMap[] = [];
    const payload: JsonValue[] = bindings.map((binding, frame) => ({
      event: operation.action,
      session: operation.params.session,
      channel: options.channel,
      chunks: binding.compiled.parts.map((part, index) => {
        if (part.type !== "text")
          throw new PromptError("SOCKET_CAPABILITY", "This socket version accepts text only.");
        mappings.push({
          path: [frame, "chunks", index, "text"],
          binding: binding.key,
          record: binding.record,
          part: part.id,
          start: 0,
          end: part.text.length,
          relation: "copy",
        });
        return { text: part.text };
      }),
    }));
    if (operation.action === "flush")
      payload.push({ event: "flush", session: operation.params.session });
    return { payload, mappings, decisions: [{ kind: "socket-framing", channel: options.channel }] };
  },
};
function operation() {
  const content = snapshot("Compare x² and y². 🧪");
  return consumerOperation({
    adapter: identity,
    action: "append",
    bindings: [
      { key: "instruction", content },
      { key: "reminder", content },
    ],
    params: { session: "s1", prior: { cursor: 42 } },
  });
}
function code(action: () => unknown, expected: string) {
  try {
    action();
    throw new Error("Expected failure");
  } catch (error) {
    expect(error).toBeInstanceOf(PromptError);
    expect((error as PromptError).diagnostic.code).toBe(expected);
  }
}
function signed(input: unknown) {
  const { fingerprint: _, ...body } = JSON.parse(JSON.stringify(input));
  return { ...body, fingerprint: semanticFingerprint(body) };
}

describe("consumer-owned, versioned adapters", () => {
  it("stores semantic bindings once and replays a socket event batch from plain JSON", () => {
    let authorCalls = 0;
    const author = () => {
      authorCalls++;
      return operation();
    };
    const authored = author();
    const ledger = serializeOperation(authored);
    const restored = parseOperation(ledger);
    expect(Object.keys(restored.records)).toHaveLength(1);
    expect(restored.operation).toMatchObject({
      kind: "custom",
      adapter: identity,
      action: "append",
    });
    expect(ledger).not.toContain('"payload"');
    expect(ledger).not.toContain('"mappings"');
    const prepared = lowerOperation(restored, target, {}, [socketAdapter]);
    expect(prepared.status).toBe("prepared-not-sent");
    expect(prepared.payload).toEqual([
      {
        event: "append",
        session: "s1",
        channel: "analysis",
        chunks: [{ text: "Compare x² and y². 🧪" }],
      },
      {
        event: "append",
        session: "s1",
        channel: "analysis",
        chunks: [{ text: "Compare x² and y². 🧪" }],
      },
    ]);
    expect(prepared.mappings.map((map) => map.binding)).toEqual(["instruction", "reminder"]);
    const wire = captureWire(prepared, prepared.payload, {
      capturedAt: "2026-10-09T12:00:00Z",
      transportId: "event-batch-1",
    });
    const replay = verifyWire(restored, parseWire(serializeWire(wire)), [socketAdapter]);
    expect(replay).toMatchObject({ equal: true });
    expect(authorCalls).toBe(1);
    const changed = captureWire(prepared, [{ event: "dropped" }], { capturedAt: wire.capturedAt });
    expect(verifyWire(restored, changed, [socketAdapter])).toMatchObject({ equal: false });
  });

  it("supports session-control actions without a prompt or request envelope", () => {
    const flush = consumerOperation({
      adapter: identity,
      action: "flush",
      bindings: [],
      params: { session: "s1" },
    });
    expect(flush.records).toEqual({});
    const controlOnly: ConsumerAdapter = {
      ...socketAdapter,
      capabilities: { actions: ["flush"], content: [], assets: [] },
    };
    const prepared = lowerOperation(flush, target, {}, [controlOnly]);
    expect(prepared.payload).toEqual([{ event: "flush", session: "s1" }]);
    expect(prepared.mappings).toEqual([]);
  });

  it("validates version-qualified capability declarations before running consumer code", () => {
    let calls = 0;
    const invalid: unknown[] = [
      undefined,
      null,
      {},
      { ...textCapabilities, actions: "append" },
      { ...textCapabilities, actions: ["append", "append"] },
      { ...textCapabilities, actions: [""] },
      { ...textCapabilities, content: ["text", "text"] },
      { ...textCapabilities, content: ["audio"] },
      { ...textCapabilities, assets: ["upload"] },
      { ...textCapabilities, assets: ["path", "path"] },
      { ...textCapabilities, future: true },
    ];
    for (const capabilities of invalid) {
      const adapter: ConsumerAdapter = {
        identity,
        capabilities: capabilities as ConsumerAdapter["capabilities"],
        lower() {
          calls++;
          return { payload: null, mappings: [], decisions: [] };
        },
      };
      code(() => lowerOperation(operation(), target, {}, [adapter]), "ADAPTER_CAPABILITIES");
    }
    const noContent: ConsumerAdapter = {
      identity,
      capabilities: { actions: ["append"], content: [], assets: [] },
      lower() {
        calls++;
        return { payload: null, mappings: [], decisions: [] };
      },
    };
    code(() => lowerOperation(operation(), target, {}, [noContent]), "ADAPTER_CAPABILITY");
    expect(calls).toBe(0);
  });

  it("requires the exact recorded implementation for lowering and wire verification", () => {
    const record = operation();
    const newer = { ...socketAdapter, identity: { ...identity, version: "2.0.0" } };
    code(() => lowerOperation(record, target), "ADAPTER_UNAVAILABLE");
    code(() => lowerOperation(record, target, {}, [newer]), "ADAPTER_UNAVAILABLE");
    code(
      () => lowerOperation(record, { ...target, adapter: newer.identity }, {}, [newer]),
      "ADAPTER_TARGET",
    );
    code(
      () => lowerOperation(record, { kind: "claude-channel/1" }, {}, [socketAdapter]),
      "ADAPTER_TARGET",
    );
    code(
      () => lowerOperation(record, target, {}, [socketAdapter, socketAdapter]),
      "ADAPTER_AMBIGUOUS",
    );
    code(() => lowerOperation(record, target, {}, null as never), "ADAPTER_REGISTRY");
    code(() => lowerOperation(record, target, {}, [{} as never]), "ADAPTER_REGISTRY");
    const prepared = lowerOperation(record, target, {}, [newer, socketAdapter]);
    const wire = captureWire(prepared, prepared.payload, { capturedAt: "2026-10-09T12:00:00Z" });
    code(() => verifyWire(record, wire), "ADAPTER_UNAVAILABLE");
    code(() => verifyWire(record, wire, [newer]), "ADAPTER_UNAVAILABLE");
  });

  it("preserves explicit capability refusals and reports thrown adapter failures", () => {
    const record = consumerOperation({ adapter: identity, action: "replace", bindings: [] });
    code(() => lowerOperation(record, target, {}, [socketAdapter]), "ADAPTER_CAPABILITY");
    const narrower: ConsumerAdapter = {
      ...socketAdapter,
      capabilities: { ...textCapabilities, actions: ["replace"] },
    };
    code(() => lowerOperation(record, target, {}, [narrower]), "SOCKET_CAPABILITY");
    const broken: ConsumerAdapter = {
      identity,
      capabilities: textCapabilities,
      lower() {
        throw new Error("broken socket projection");
      },
    };
    code(() => lowerOperation(operation(), target, {}, [broken]), "ADAPTER_FAILED");
    const image = consumerOperation({
      adapter: identity,
      action: "append",
      bindings: [{ key: "plot", content: snapshot(Image({ asset: { id: "plot" } })) }],
    });
    code(() => lowerOperation(image, target, {}, [socketAdapter]), "ADAPTER_CAPABILITY");
  });

  it("owns JSON state and results without freezing caller objects, and freezes all adapter inputs", () => {
    const params = { session: "s1", state: { cursor: 3 } };
    const options = { channel: "science" };
    const assets = { plot: { kind: "path" as const, value: "/plots/one.png" } };
    const record = consumerOperation({
      adapter: identity,
      action: "append",
      bindings: [{ key: "one", content: snapshot("a") }],
      params,
    });
    params.state.cursor = 99;
    const returned = {
      payload: { state: [1] },
      mappings: [] as DeliveryMap[],
      decisions: [{ kind: "empty" }],
    };
    const adapter: ConsumerAdapter = {
      identity,
      capabilities: textCapabilities,
      lower(input) {
        expect(input.operation.params).toEqual({ session: "s1", state: { cursor: 3 } });
        expect(Object.isFrozen(input.operation.params.state)).toBe(true);
        expect(Object.isFrozen(input.options)).toBe(true);
        expect(Object.isFrozen(input.bindings[0].compiled.parts)).toBe(true);
        expect(Object.isFrozen(input.assets.plot)).toBe(true);
        return returned;
      },
    };
    const prepared = lowerOperation(
      record,
      { kind: "custom", adapter: identity, options },
      assets,
      [adapter],
    );
    options.channel = "changed";
    assets.plot.value = "changed";
    returned.payload.state.push(2);
    expect(Object.isFrozen(params.state)).toBe(false);
    expect(Object.isFrozen(options)).toBe(false);
    expect(Object.isFrozen(assets.plot)).toBe(false);
    expect(Object.isFrozen(returned.payload)).toBe(false);
    expect(prepared.target).toMatchObject({ options: { channel: "science" } });
    expect(prepared.assets.plot.value).toBe("/plots/one.png");
    expect(prepared.payload).toEqual({ state: [1] });
    expect(Object.isFrozen(prepared.payload)).toBe(true);
  });

  it("enforces strict storable JSON and schema validation before callback execution", () => {
    const record = operation();
    let reads = 0;
    const params = {
      get session() {
        reads++;
        return "s1";
      },
    };
    code(
      () => consumerOperation({ adapter: identity, action: "append", bindings: [], params }),
      "CONSUMER_OPERATION",
    );
    expect(reads).toBe(0);
    code(
      () =>
        consumerOperation({
          adapter: identity,
          action: "append",
          bindings: [],
          params: { socket: () => {} } as never,
        }),
      "CONSUMER_OPERATION",
    );
    code(
      () =>
        consumerOperation({
          adapter: { ...identity, version: "" },
          action: "append",
          bindings: [],
        }),
      "ADAPTER_IDENTITY",
    );
    code(
      () => consumerOperation({ adapter: identity, action: "", bindings: [] }),
      "CONSUMER_OPERATION",
    );
    code(
      () =>
        consumerOperation({
          adapter: identity,
          action: "append",
          bindings: [
            { key: "x", content: snapshot("a") },
            { key: "x", content: snapshot("b") },
          ],
        }),
      "CONSUMER_OPERATION",
    );
    code(
      () =>
        parseOperation(
          signed({ ...record, operation: { ...record.operation, callback: "hidden" } }),
        ),
      "CONSUMER_OPERATION",
    );
    code(() => parseOperation(signed({ ...record, records: {} })), "RECORD_REFERENCE");
    code(
      () => parseOperation(signed({ ...record, operation: { ...record.operation, params: [] } })),
      "CONSUMER_OPERATION",
    );
    code(
      () =>
        lowerOperation(record, { ...target, options: { revision: undefined } } as never, {}, [
          socketAdapter,
        ]),
      "TARGET_KIND",
    );
  });

  it("validates copy-map addresses, membership, and exact UTF-16 contents", () => {
    const record = operation();
    const changes: Readonly<Record<string, unknown>>[] = [
      { path: [10, "chunks"] },
      { path: ["0", "chunks"] },
      { path: [0, "constructor"] },
      { path: [0, "chunks", 0, "text", 0] },
      { binding: "unknown" },
      { record: "sha256:unknown" },
      { part: "missing" },
      { start: -1 },
      { end: 1 },
      { end: 200 },
      { start: 0.5 },
      { relation: "asset-reference" },
      { relation: "claimed-exact-source" },
    ];
    for (const change of changes) {
      const adapter: ConsumerAdapter = {
        identity,
        capabilities: textCapabilities,
        lower(input) {
          const result = socketAdapter.lower(input);
          return { ...result, mappings: [{ ...result.mappings[0], ...change }] as DeliveryMap[] };
        },
      };
      code(() => lowerOperation(record, target, {}, [adapter]), "ADAPTER_MAPPING");
    }
    const changedText: ConsumerAdapter = {
      identity,
      capabilities: textCapabilities,
      lower(input) {
        const result = socketAdapter.lower(input);
        return {
          ...result,
          payload: [{ chunks: [{ text: "X".repeat("Compare x² and y². 🧪".length) }] }],
        };
      },
    };
    code(() => lowerOperation(record, target, {}, [changedText]), "ADAPTER_MAPPING");
    const generated: ConsumerAdapter = {
      identity,
      capabilities: textCapabilities,
      lower({ bindings }) {
        return {
          payload: "prefix",
          mappings: [
            {
              path: [],
              binding: bindings[0].key,
              record: bindings[0].record,
              relation: "generated",
            },
          ],
          decisions: [],
        };
      },
    };
    expect(lowerOperation(record, target, {}, [generated]).mappings[0].relation).toBe("generated");
  });

  it("permits consumer asset projection only with an actual bound image part", () => {
    const record = consumerOperation({
      adapter: identity,
      action: "append",
      bindings: [
        {
          key: "plot",
          content: snapshot(Group({ children: ["Inspect ", Image({ asset: { id: "plot" } })] })),
        },
      ],
    });
    const adapter: ConsumerAdapter = {
      identity,
      capabilities: { actions: ["append"], content: ["text", "image"], assets: ["path"] },
      lower({ bindings, assets }) {
        const binding = bindings[0];
        const image = binding.compiled.parts.find((part) => part.type === "image");
        if (!image) throw new Error("missing fixture image");
        return {
          payload: { event: "attachment", path: assets.plot.value },
          mappings: [
            {
              path: ["path"],
              binding: binding.key,
              record: binding.record,
              part: image.id,
              relation: "asset-reference",
            },
          ],
          decisions: [{ kind: "asset-policy", representation: "path" }],
        };
      },
    };
    const assets = { plot: { kind: "path" as const, value: "/tmp/plot.png" } };
    expect(lowerOperation(record, target, assets, [adapter]).payload).toEqual({
      event: "attachment",
      path: "/tmp/plot.png",
    });
    const unbound: ConsumerAdapter = {
      ...adapter,
      lower(input) {
        const result = adapter.lower(input);
        const { part: _, ...map } = result.mappings[0];
        return { ...result, mappings: [map] };
      },
    };
    code(() => lowerOperation(record, target, assets, [unbound]), "ADAPTER_MAPPING");
  });

  it("enforces image binding, revision, and representation policy before custom lowering", () => {
    let calls = 0;
    const adapter: ConsumerAdapter = {
      identity,
      capabilities: { actions: ["append"], content: ["text", "image"], assets: ["path"] },
      lower() {
        calls++;
        return { payload: null, mappings: [], decisions: [] };
      },
    };
    const prompt = Choice({
      name: "plot",
      children: Image({ asset: { id: "plot", digest: "sha256:original" } }),
      short: "Plot omitted.",
    });
    const withPlot = consumerOperation({
      adapter: identity,
      action: "append",
      bindings: [{ key: "plot", content: snapshot(prompt) }],
    });
    const asset = { kind: "path" as const, value: "/plots/one.png", digest: "sha256:original" };
    code(() => lowerOperation(withPlot, target, {}, [adapter]), "ASSET_BINDING");
    code(
      () =>
        lowerOperation(withPlot, target, { plot: { kind: "path", value: asset.value } }, [adapter]),
      "ASSET_REVISION",
    );
    code(
      () =>
        lowerOperation(withPlot, target, { plot: { ...asset, digest: "sha256:replacement" } }, [
          adapter,
        ]),
      "ASSET_REVISION",
    );
    code(
      () => lowerOperation(withPlot, target, { plot: { ...asset, kind: "url" } }, [adapter]),
      "ASSET_POLICY",
    );
    expect(calls).toBe(0);
    lowerOperation(withPlot, target, { plot: asset }, [adapter]);
    expect(calls).toBe(1);
    const textOnly = consumerOperation({
      adapter: identity,
      action: "append",
      bindings: [{ key: "plot", content: snapshot(prompt, { selection: { plot: "short" } }) }],
    });
    lowerOperation(textOnly, target, {}, [{ ...adapter, capabilities: textCapabilities }]);
    expect(calls).toBe(2);
  });

  it("rejects non-JSON or asynchronous results and forged delivery status", () => {
    const results: unknown[] = [
      Promise.resolve({ payload: null, mappings: [], decisions: [] }),
      { payload: undefined, mappings: [], decisions: [] },
      { payload: null, mappings: [], decisions: ["reason"] },
      { payload: null, mappings: [], decisions: [], status: "sent" },
      {
        payload: {
          get field() {
            throw new Error("must not read");
          },
        },
        mappings: [],
        decisions: [],
      },
    ];
    for (const result of results) {
      const adapter: ConsumerAdapter = {
        identity,
        capabilities: textCapabilities,
        lower: () => result as ConsumerAdapterResult,
      };
      code(() => lowerOperation(operation(), target, {}, [adapter]), "ADAPTER_RESULT");
    }
  });
});
