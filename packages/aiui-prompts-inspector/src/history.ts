import {
  canonicalJson,
  type JsonObject,
  parseRecord,
  type SemanticRecord,
} from "@habemus-papadum/aiui-prompts";
import {
  type ConsumerAdapter,
  captureWire,
  lowerOperation,
  type OperationRecord,
  type PreparedDelivery,
  parseOperation,
  parseWire,
  type WireRecord,
} from "@habemus-papadum/aiui-prompts/operations";

/** Hosts retrieve records and exact adapter implementations; loading never performs I/O. */
export interface InspectionLoadOptions {
  /** Required when the input is a delivery or wire record referencing this operation. */
  operation?: unknown;
  /** Exact historical versions only. Missing implementations leave payloads inspectable. */
  adapters?: readonly ConsumerAdapter[];
}

export interface InspectionBinding {
  readonly key: string;
  readonly label: string;
  readonly record: SemanticRecord;
}

export interface InspectionDocument {
  readonly kind: "semantic" | "operation" | "delivery" | "wire";
  readonly bindings: readonly InspectionBinding[];
  readonly operation?: OperationRecord;
  /** Captured data is shown separately from the newly derived delivery. */
  readonly wire?: WireRecord;
  /** Untrusted saved artifact, for display only; maps used by the viewer are re-derived. */
  readonly prepared?: JsonObject;
  readonly delivery?: PreparedDelivery;
  readonly verification?:
    | { readonly status: "equal" | "different" }
    | { readonly status: "unavailable"; readonly reason: string };
}

function bindings(operation: OperationRecord): readonly InspectionBinding[] {
  const body = operation.operation;
  const binding = (key: string, label: string, id: string): InspectionBinding =>
    Object.freeze({ key, label, record: operation.records[id] });
  if (body.kind === "custom")
    return body.bindings.map((item) => binding(item.key, item.key, item.content));
  if (body.kind === "channel") return [binding("content", "Channel content", body.content)];
  if (body.kind === "session")
    // A tools-only update or a connect may bind no record at all.
    return body.content === null ? [] : [binding("content", body.action, body.content)];
  return [
    ...(body.instructions ? [binding("instructions", "Instructions", body.instructions)] : []),
    ...body.messages.map((item) =>
      binding(`message:${item.key}`, `${item.role}: ${item.key}`, item.content),
    ),
  ];
}

/**
 * Load saved JSON without author functions or session state. An operation keeps its
 * individual bindings; conversation history is never turned into an optimizable prompt.
 * Derived mappings always come from the recorded implementation, never an untrusted cache.
 */
export function loadInspection(
  input: unknown,
  options: InspectionLoadOptions = {},
): InspectionDocument {
  // canonicalJson rejects accessors/non-JSON without invoking user code.
  const value = JSON.parse(canonicalJson(typeof input === "string" ? JSON.parse(input) : input));
  if (value?.kind === "aiui.prompt") {
    const record = parseRecord(value);
    return Object.freeze({
      kind: "semantic",
      bindings: Object.freeze([Object.freeze({ key: "prompt", label: "Prompt", record })]),
    });
  }
  if (value?.kind === "aiui.prompt.operation") {
    const operation = parseOperation(value);
    return Object.freeze({
      kind: "operation",
      operation,
      bindings: Object.freeze(bindings(operation)),
    });
  }
  if (value?.kind !== "aiui.prompt.wire" && value?.kind !== "aiui.prompt.delivery")
    throw new Error(
      "Expected a semantic prompt, operation, prepared delivery, or captured wire record.",
    );
  const captured = value.kind === "aiui.prompt.wire";
  // This validates the delivery envelope using the same boundary as transport capture.
  // Its cached mappings are never consumed; full equality is checked against re-derivation below.
  const wire = captured
    ? parseWire(value)
    : captureWire(value, value.payload, { capturedAt: "2000-01-01T00:00:00Z" });
  if (options.operation === undefined)
    throw new Error(
      "Load the referenced semantic operation alongside this delivery or wire record.",
    );
  const operation = parseOperation(options.operation);
  if (operation.fingerprint !== wire.operation)
    throw new Error("This artifact references a different semantic operation.");
  const base = {
    kind: captured ? ("wire" as const) : ("delivery" as const),
    operation,
    bindings: Object.freeze(bindings(operation)),
    ...(captured ? { wire } : { prepared: value as JsonObject }),
  };
  try {
    const delivery = lowerOperation(operation, wire.target, wire.assets, options.adapters);
    const equal = captured
      ? canonicalJson(delivery.payload) === canonicalJson(wire.payload)
      : canonicalJson(delivery) === canonicalJson(value);
    return Object.freeze({
      ...base,
      delivery,
      verification: Object.freeze({ status: equal ? ("equal" as const) : ("different" as const) }),
    });
  } catch (error) {
    return Object.freeze({
      ...base,
      verification: Object.freeze({ status: "unavailable" as const, reason: String(error) }),
    });
  }
}
