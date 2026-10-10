/** Delivery records are semantic operations, not a universal request-shaped provider abstraction. */
import { chunksOf, rehydrate } from "./compile.ts";
import {
  canonicalJson,
  copyJson,
  freeze,
  type JsonObject,
  type JsonValue,
  sha256,
} from "./json.ts";
import { type CompiledPrompt, PromptError, type SemanticRecord } from "./model.ts";
import { parseRecord } from "./record.ts";
import { projectToolSchemas, type ToolSnapshot, validateToolSnapshot } from "./tools-data.ts";

export type History =
  | { readonly kind: "none" }
  | {
      readonly kind: "provider-items";
      readonly protocol: "openai-responses/1";
      readonly items: readonly JsonValue[];
    }
  | {
      readonly kind: "remote";
      readonly provider: "openai";
      readonly reference: {
        readonly kind: "conversation" | "previous-response";
        readonly id: string;
      };
    };
/**
 * Session actions. `update` is a Realtime `session.update`: the instructions
 * when bound, plus the host's own session block (`session`: audio, tools,
 * limits — plain JSON the host holds at send time) merged in. `connect` is
 * the baked session config a Realtime session is minted and connected with:
 * the same block plus model and voice, with no event envelope. The appends
 * are the repository's live-session protocol; `input` and `respond` are the
 * Realtime conversation item and per-response instructions.
 */
export type SessionAction =
  | "update"
  | "connect"
  | "append-instructions"
  | "append-thinking"
  | "append-commentary"
  | "input"
  | "respond";
/** Consumer-owned, immutable implementation identity. Resolution is always exact. */
export type AdapterIdentity = Readonly<{ name: string; version: string }>;
export type ConsumerOperation = Readonly<{
  kind: "custom";
  adapter: AdapterIdentity;
  action: string;
  bindings: readonly Readonly<{ key: string; content: string }>[];
  params: JsonObject;
}>;
type Body =
  | ConsumerOperation
  | {
      readonly kind: "session";
      readonly action: SessionAction;
      /** The bound record; `update` and `connect` may carry none (a tools-only update). */
      readonly content: string | null;
      readonly sessionId: string;
      /** The client event id the host stamped; `connect` sends no event. */
      readonly eventId: string | null;
      readonly delegationId: string | null;
      /** The host's session block for `update` / `connect` — never instructions. */
      readonly session?: JsonObject;
      /** For an append under a per-message cap: which chunk of the bound record this one carries. */
      readonly chunk?: ChunkReference;
    }
  | {
      readonly kind: "channel";
      readonly content: string;
      readonly meta: Readonly<Record<string, string>>;
    }
  | {
      readonly kind: "response";
      readonly instructions?: string;
      readonly messages: readonly {
        readonly key: string;
        readonly role: "user" | "assistant";
        readonly content: string;
      }[];
      readonly history: History;
      readonly tools?: ToolSnapshot;
      readonly qualifyTools: boolean;
      readonly outputSchema?: JsonObject;
      /** Request fields the host chooses per call; absent means the API's default. */
      readonly toolChoice?: JsonValue;
      readonly reasoning?: JsonObject;
      readonly store?: boolean;
    };
export type OperationRecord = Readonly<{
  kind: "aiui.prompt.operation";
  schemaVersion: 1;
  fingerprint: string;
  records: Readonly<Record<string, SemanticRecord>>;
  operation: Body;
}>;
export type Target =
  | { readonly kind: "custom"; readonly adapter: AdapterIdentity; readonly options: JsonObject }
  | { readonly kind: "openai-realtime/1" }
  | { readonly kind: "live-session/1" }
  | { readonly kind: "claude-channel/1" }
  | { readonly kind: "openai-responses/1"; readonly model: string };
export type AssetBinding = Readonly<{
  kind: "url" | "file" | "path" | "caption";
  value: string;
  label?: string;
  digest?: string;
}>;
export type AssetBindings = Readonly<Record<string, AssetBinding>>;
/**
 * Versioned with the adapter implementation. These are upper bounds: lower()
 * can reject narrower protocol combinations, but cannot accept undeclared ones.
 * Empty content/assets arrays allow control actions that have no prompt/media.
 */
export interface ConsumerCapabilities {
  readonly actions: readonly string[];
  readonly content: readonly ("text" | "image")[];
  readonly assets: readonly AssetBinding["kind"][];
}
export interface DeliveryMap {
  readonly path: readonly (string | number)[];
  readonly binding: string;
  readonly record: string;
  readonly part?: string;
  readonly start?: number;
  readonly end?: number;
  /** `copy` is a whole text part; `slice` a verbatim range of one (`source` bounds it). */
  readonly relation: "copy" | "slice" | "asset-reference" | "generated";
  readonly source?: Readonly<{ start: number; end: number }>;
  readonly origin?: JsonObject;
}
/** One chunk of a record partitioned by a `Chunk` node: `index` of `count`. */
export type ChunkReference = Readonly<{ index: number; count: number }>;
export interface ConsumerAdapterInput {
  readonly operation: ConsumerOperation;
  readonly options: JsonObject;
  readonly bindings: readonly Readonly<{
    key: string;
    record: string;
    compiled: CompiledPrompt;
  }>[];
  readonly assets: AssetBindings;
}
export interface ConsumerAdapterResult {
  readonly payload: JsonValue;
  /** `copy` identifies a whole text part at exact UTF-16 payload bounds. */
  readonly mappings: readonly DeliveryMap[];
  readonly decisions: readonly JsonObject[];
}
/**
 * A pure, synchronous consumer-owned lowering implementation. Store all inputs
 * in operation params/options/bindings; socket handles and sending stay outside.
 * Retain each implementation needed to replay its exact recorded version.
 */
export interface ConsumerAdapter {
  readonly identity: AdapterIdentity;
  readonly capabilities: ConsumerCapabilities;
  readonly lower: (input: ConsumerAdapterInput) => ConsumerAdapterResult;
}
export interface PreparedDelivery {
  readonly kind: "aiui.prompt.delivery";
  readonly schemaVersion: 1;
  readonly status: "prepared-not-sent";
  readonly lowerer: "aiui-prompts-delivery/1.0.0";
  readonly operation: string;
  readonly target: Target;
  readonly assets: AssetBindings;
  readonly payload: JsonValue;
  readonly mappings: readonly DeliveryMap[];
  readonly decisions: readonly JsonObject[];
}
export interface WireRecord {
  readonly kind: "aiui.prompt.wire";
  readonly schemaVersion: 1;
  readonly status: "captured";
  readonly operation: string;
  readonly lowerer: PreparedDelivery["lowerer"];
  readonly target: Target;
  readonly assets: AssetBindings;
  readonly payload: JsonValue;
  readonly capturedAt: string;
  readonly transportId?: string;
}
const hash = (value: unknown) => `sha256:${sha256(canonicalJson(value))}`;
const fail = (code: string, message: string): never => {
  throw new PromptError(code, message);
};
function readJson(input: unknown, code: string): unknown {
  try {
    return copyJson(typeof input === "string" ? JSON.parse(input) : input);
  } catch (error) {
    return fail(code, error instanceof Error ? error.message : "Invalid plain JSON.");
  }
}
function object(input: unknown, code: string, label: string): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    return fail(code, `${label} must be an object.`);
  return input as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, names: readonly string[], code: string): void {
  const unexpected = Object.keys(value).find((key) => !names.includes(key));
  if (unexpected) fail(code, `Unknown field ${unexpected}.`);
}
function nonempty(value: unknown, code: string, label: string): string {
  if (typeof value !== "string" || value.length === 0)
    return fail(code, `${label} must be a nonempty string.`);
  return value;
}
function historyValue(input: unknown): History {
  const value = object(input, "HISTORY", "History");
  if (value.kind === "none") fields(value, ["kind"], "HISTORY");
  else if (value.kind === "provider-items") {
    fields(value, ["kind", "protocol", "items"], "HISTORY");
    if (value.protocol !== "openai-responses/1" || !Array.isArray(value.items))
      fail("HISTORY_PROTOCOL", "Unsupported history protocol or malformed replay items.");
  } else if (value.kind === "remote") {
    fields(value, ["kind", "provider", "reference"], "HISTORY");
    const reference = object(value.reference, "HISTORY_PROTOCOL", "Remote history reference");
    fields(reference, ["kind", "id"], "HISTORY_PROTOCOL");
    if (
      value.provider !== "openai" ||
      !["conversation", "previous-response"].includes(reference.kind as string)
    )
      fail("HISTORY_PROTOCOL", "Unsupported remote history reference.");
    nonempty(reference.id, "HISTORY_PROTOCOL", "Remote reference ID");
  } else fail("HISTORY", "Unsupported history kind.");
  return value as History;
}
function adapterIdentity(input: unknown): AdapterIdentity {
  const value = object(input, "ADAPTER_IDENTITY", "Adapter identity");
  fields(value, ["name", "version"], "ADAPTER_IDENTITY");
  nonempty(value.name, "ADAPTER_IDENTITY", "Adapter name");
  nonempty(value.version, "ADAPTER_IDENTITY", "Adapter version");
  return value as AdapterIdentity;
}
function adapterCapabilities(input: unknown): ConsumerCapabilities {
  const value = object(
    readJson(input, "ADAPTER_CAPABILITIES"),
    "ADAPTER_CAPABILITIES",
    "Consumer capabilities",
  );
  fields(value, ["actions", "content", "assets"], "ADAPTER_CAPABILITIES");
  for (const name of ["actions", "content", "assets"] as const) {
    const entries = value[name];
    if (!Array.isArray(entries)) fail("ADAPTER_CAPABILITIES", `${name} must be an array.`);
    const seen = new Set<string>();
    for (const entry of entries as unknown[]) {
      const item = nonempty(entry, "ADAPTER_CAPABILITIES", `Declared ${name} entry`);
      if (seen.has(item)) fail("ADAPTER_CAPABILITIES", `Duplicate ${name} entry ${item}.`);
      if (name === "content" && !["text", "image"].includes(item))
        fail("ADAPTER_CAPABILITIES", "Unsupported declared content kind.");
      if (name === "assets" && !["url", "file", "path", "caption"].includes(item))
        fail("ADAPTER_CAPABILITIES", "Unsupported declared asset representation.");
      seen.add(item);
    }
  }
  return freeze(value as unknown as ConsumerCapabilities);
}
function targetValue(input: unknown): Target {
  const value = object(input, "TARGET_KIND", "Target");
  if (value.kind === "custom") {
    fields(value, ["kind", "adapter", "options"], "TARGET_KIND");
    adapterIdentity(value.adapter);
    object(value.options, "TARGET_KIND", "Consumer target options");
  } else if (value.kind === "openai-responses/1") {
    fields(value, ["kind", "model"], "TARGET_KIND");
    nonempty(value.model, "TARGET_KIND", "Responses model");
  } else if (
    ["openai-realtime/1", "live-session/1", "claude-channel/1"].includes(value.kind as string)
  )
    fields(value, ["kind"], "TARGET_KIND");
  else fail("TARGET_KIND", "Unsupported delivery target version.");
  return value as Target;
}
function assetValues(input: unknown): AssetBindings {
  const values = object(input, "ASSET_BINDING", "Asset bindings");
  for (const [id, input] of Object.entries(values)) {
    nonempty(id, "ASSET_BINDING", "Asset ID");
    const value = object(input, "ASSET_BINDING", "Asset representation");
    fields(value, ["kind", "value", "label", "digest"], "ASSET_BINDING");
    if (!["url", "file", "path", "caption"].includes(value.kind as string))
      fail("ASSET_BINDING", "Unsupported asset representation.");
    nonempty(value.value, "ASSET_BINDING", "Asset representation value");
    if ("label" in value && typeof value.label !== "string")
      fail("ASSET_BINDING", "Asset label must be a string.");
    if ("digest" in value) nonempty(value.digest, "ASSET_BINDING", "Asset digest");
  }
  return values as AssetBindings;
}
function makeOperation(operation: Body, values: readonly SemanticRecord[]): OperationRecord {
  const records: Record<string, SemanticRecord> = {};
  for (const value of values) {
    const record = parseRecord(value);
    records[record.fingerprint] = record;
  }
  const data = copyJson({
    kind: "aiui.prompt.operation" as const,
    schemaVersion: 1 as const,
    records,
    operation,
  });
  return parseOperation({ ...data, fingerprint: hash(data) });
}
/** Capture a consumer action and deduplicated semantic bindings, never a callback or payload. */
export function consumerOperation(options: {
  adapter: AdapterIdentity;
  action: string;
  bindings: readonly { key: string; content: SemanticRecord }[];
  params?: JsonObject;
}): OperationRecord {
  const value = object(
    readJson(options, "CONSUMER_OPERATION"),
    "CONSUMER_OPERATION",
    "Consumer options",
  );
  fields(value, ["adapter", "action", "bindings", "params"], "CONSUMER_OPERATION");
  if (!Array.isArray(value.bindings))
    fail("CONSUMER_OPERATION", "Consumer bindings must be an array.");
  const records: SemanticRecord[] = [];
  const bindings = (value.bindings as unknown[]).map((input) => {
    const binding = object(input, "CONSUMER_OPERATION", "Consumer binding");
    fields(binding, ["key", "content"], "CONSUMER_OPERATION");
    const record = parseRecord(binding.content);
    records.push(record);
    return { key: binding.key, content: record.fingerprint };
  });
  return makeOperation(
    {
      kind: "custom",
      adapter: value.adapter,
      action: value.action,
      bindings,
      params: "params" in value ? value.params : {},
    } as ConsumerOperation,
    records,
  );
}
export function sessionOperation(
  content: SemanticRecord | null,
  options: {
    action: SessionAction;
    sessionId: string;
    eventId?: string;
    delegationId?: string | null;
    session?: JsonObject;
    chunk?: ChunkReference;
  },
): OperationRecord {
  const record = content === null ? null : parseRecord(content);
  const value = object(
    readJson(options, "SESSION_OPERATION"),
    "SESSION_OPERATION",
    "Session options",
  );
  fields(
    value,
    ["action", "sessionId", "eventId", "delegationId", "session", "chunk"],
    "SESSION_OPERATION",
  );
  const action = value.action as SessionAction;
  const block = action === "update" || action === "connect";
  if ("chunk" in value) chunkReference(value.chunk, action);
  if (record === null && !block)
    fail("SESSION_OPERATION", `A ${String(action)} operation binds a semantic record.`);
  if ("session" in value && !block)
    fail("SESSION_OPERATION", "Only update and connect carry a session block.");
  if (
    "session" in value &&
    "instructions" in object(value.session, "SESSION_OPERATION", "Session block")
  )
    fail(
      "SESSION_OPERATION",
      "Instructions travel as the bound record, never in the session block.",
    );
  if (action !== "connect" && typeof value.eventId !== "string")
    fail(
      "SESSION_OPERATION",
      "Every session event needs the host's eventId; only connect has none.",
    );
  return makeOperation(
    {
      kind: "session",
      action,
      content: record === null ? null : record.fingerprint,
      sessionId: value.sessionId,
      eventId: typeof value.eventId === "string" ? value.eventId : null,
      delegationId: value.delegationId ?? null,
      ...("session" in value ? { session: value.session } : {}),
      ...("chunk" in value ? { chunk: value.chunk } : {}),
    } as Body,
    record === null ? [] : [record],
  );
}
/** A chunk reference rides an append only, and names a chunk inside its count. */
function chunkReference(input: unknown, action: string): ChunkReference {
  if (!action.startsWith("append-"))
    fail("SESSION_OPERATION", "Only an append is delivered in chunks.");
  const value = object(input, "SESSION_OPERATION", "Chunk reference");
  fields(value, ["index", "count"], "SESSION_OPERATION");
  if (
    !Number.isSafeInteger(value.index) ||
    !Number.isSafeInteger(value.count) ||
    (value.count as number) < 1 ||
    (value.index as number) < 0 ||
    (value.index as number) >= (value.count as number)
  )
    fail("SESSION_OPERATION", "A chunk reference is an index inside a positive count.");
  return value as ChunkReference;
}
export function channelPush(
  content: SemanticRecord,
  meta: Readonly<Record<string, string>> = { kind: "prompt" },
): OperationRecord {
  const record = parseRecord(content);
  const ownedMeta = object(readJson(meta, "CHANNEL_META"), "CHANNEL_META", "Channel metadata");
  return makeOperation({ kind: "channel", content: record.fingerprint, meta: ownedMeta } as Body, [
    record,
  ]);
}
export function responseOperation(options: {
  input?: SemanticRecord;
  messages?: readonly { key: string; role: "user" | "assistant"; content: SemanticRecord }[];
  instructions?: SemanticRecord;
  history?: History;
  tools?: ToolSnapshot;
  qualifyTools?: boolean;
  outputSchema?: JsonObject;
  toolChoice?: JsonValue;
  reasoning?: JsonObject;
  store?: boolean;
}): OperationRecord {
  const value = object(readJson(options, "MESSAGES"), "MESSAGES", "Response options");
  fields(
    value,
    [
      "input",
      "messages",
      "instructions",
      "history",
      "tools",
      "qualifyTools",
      "outputSchema",
      "toolChoice",
      "reasoning",
      "store",
    ],
    "MESSAGES",
  );
  if ("reasoning" in value) object(value.reasoning, "MESSAGES", "Reasoning options");
  if ("store" in value && typeof value.store !== "boolean")
    fail("MESSAGES", "store must be boolean.");
  if ("input" in value === "messages" in value)
    fail("MESSAGES", "Provide input or ordered current messages, exclusively.");
  const raw =
    "messages" in value ? value.messages : [{ key: "input", role: "user", content: value.input }];
  if (!Array.isArray(raw)) return fail("MESSAGES", "Current messages must be an array.");
  // A continuation round (tool outputs answered) has no new message: its
  // input is the provider items alone.
  if (!raw.length && (value.history as { kind?: string } | undefined)?.kind !== "provider-items")
    return fail(
      "MESSAGES",
      "A response needs a current message unless it continues provider items.",
    );
  const records: SemanticRecord[] = [];
  const messages = (raw as unknown[]).map((input) => {
    const message = object(input, "MESSAGES", "Current message");
    fields(message, ["key", "role", "content"], "MESSAGES");
    const record = parseRecord(message.content);
    records.push(record);
    return { key: message.key, role: message.role, content: record.fingerprint };
  });
  let instructions: SemanticRecord | undefined;
  if ("instructions" in value) {
    instructions = parseRecord(value.instructions);
    records.push(instructions);
  }
  return makeOperation(
    {
      kind: "response",
      messages,
      ...(instructions ? { instructions: instructions.fingerprint } : {}),
      history: "history" in value ? value.history : { kind: "none" },
      qualifyTools: "qualifyTools" in value ? value.qualifyTools : false,
      ...("tools" in value ? { tools: value.tools } : {}),
      ...("outputSchema" in value ? { outputSchema: value.outputSchema } : {}),
      ...("toolChoice" in value ? { toolChoice: value.toolChoice } : {}),
      ...("reasoning" in value ? { reasoning: value.reasoning } : {}),
      ...("store" in value ? { store: value.store } : {}),
    } as Body,
    records,
  );
}

/** Import through validation before reading ledger data. Unknown schemas never fall through to latest. */
export function parseOperation(input: unknown): OperationRecord {
  const value = object(readJson(input, "OPERATION_JSON"), "OPERATION_SHAPE", "Operation record");
  if (value.kind !== "aiui.prompt.operation" || value.schemaVersion !== 1)
    fail("OPERATION_SCHEMA", "Unsupported operation schema.");
  fields(
    value,
    ["kind", "schemaVersion", "fingerprint", "records", "operation"],
    "OPERATION_SHAPE",
  );
  nonempty(value.fingerprint, "OPERATION_FINGERPRINT", "Operation fingerprint");
  const records = object(value.records, "OPERATION_SHAPE", "Semantic records");
  for (const [id, record] of Object.entries(records))
    if (parseRecord(record).fingerprint !== id)
      fail("RECORD_REFERENCE", "Record key differs from its fingerprint.");
  const body = object(value.operation, "OPERATION_SHAPE", "Operation body");
  const refs: string[] = [];
  if (body.kind === "custom") {
    fields(body, ["kind", "adapter", "action", "bindings", "params"], "CONSUMER_OPERATION");
    adapterIdentity(body.adapter);
    nonempty(body.action, "CONSUMER_OPERATION", "Consumer action");
    object(body.params, "CONSUMER_OPERATION", "Consumer params");
    if (!Array.isArray(body.bindings))
      fail("CONSUMER_OPERATION", "Consumer bindings must be an array.");
    const keys = new Set<string>();
    for (const input of body.bindings as unknown[]) {
      const binding = object(input, "CONSUMER_OPERATION", "Consumer binding");
      fields(binding, ["key", "content"], "CONSUMER_OPERATION");
      const key = nonempty(binding.key, "CONSUMER_OPERATION", "Binding key");
      if (keys.has(key)) fail("CONSUMER_OPERATION", "Consumer binding keys must be unique.");
      keys.add(key);
      refs.push(nonempty(binding.content, "RECORD_REFERENCE", "Consumer content reference"));
    }
  } else if (body.kind === "session") {
    fields(
      body,
      ["kind", "action", "content", "sessionId", "eventId", "delegationId", "session", "chunk"],
      "SESSION_OPERATION",
    );
    const action = body.action as string;
    if (
      ![
        "update",
        "connect",
        "append-instructions",
        "append-thinking",
        "append-commentary",
        "input",
        "respond",
      ].includes(action)
    )
      fail("SESSION_OPERATION", "Unsupported session action.");
    const block = action === "update" || action === "connect";
    nonempty(body.sessionId, "SESSION_OPERATION", "Session ID");
    if (body.eventId === null) {
      if (action !== "connect") fail("SESSION_OPERATION", "Only connect sends no event.");
    } else nonempty(body.eventId, "SESSION_OPERATION", "Event ID");
    if (body.delegationId !== null)
      nonempty(body.delegationId, "SESSION_OPERATION", "Delegation ID");
    if ("session" in body) {
      if (!block) fail("SESSION_OPERATION", "Only update and connect carry a session block.");
      const session = object(body.session, "SESSION_OPERATION", "Session block");
      if ("instructions" in session)
        fail(
          "SESSION_OPERATION",
          "Instructions travel as the bound record, never in the session block.",
        );
    }
    if (body.content === null) {
      if (!block) fail("RECORD_REFERENCE", `A ${action} operation binds a semantic record.`);
    } else refs.push(nonempty(body.content, "RECORD_REFERENCE", "Session content reference"));
    if ("chunk" in body) chunkReference(body.chunk, action);
  } else if (body.kind === "channel") {
    fields(body, ["kind", "content", "meta"], "CHANNEL_META");
    const meta = object(body.meta, "CHANNEL_META", "Channel metadata");
    if (Object.values(meta).some((item) => typeof item !== "string"))
      fail("CHANNEL_META", "Channel metadata values must be strings.");
    refs.push(nonempty(body.content, "RECORD_REFERENCE", "Channel content reference"));
  } else if (body.kind === "response") {
    fields(
      body,
      [
        "kind",
        "instructions",
        "messages",
        "history",
        "tools",
        "qualifyTools",
        "outputSchema",
        "toolChoice",
        "reasoning",
        "store",
      ],
      "MESSAGES",
    );
    if ("reasoning" in body) object(body.reasoning, "MESSAGES", "Reasoning options");
    if ("store" in body && typeof body.store !== "boolean")
      fail("MESSAGES", "store must be boolean.");
    const messages = body.messages;
    if (!Array.isArray(messages)) return fail("MESSAGES", "Current messages must be an array.");
    if (
      !messages.length &&
      (body.history as { kind?: string } | undefined)?.kind !== "provider-items"
    )
      return fail(
        "MESSAGES",
        "A response needs a current message unless it continues provider items.",
      );
    const keys = new Set<string>();
    for (const input of messages as unknown[]) {
      const message = object(input, "MESSAGES", "Current message");
      fields(message, ["key", "role", "content"], "MESSAGES");
      const key = nonempty(message.key, "MESSAGES", "Message key");
      if (keys.has(key) || !["user", "assistant"].includes(message.role as string))
        fail("MESSAGES", "Current messages need unique keys and supported roles.");
      keys.add(key);
      refs.push(nonempty(message.content, "RECORD_REFERENCE", "Message content reference"));
    }
    if ("instructions" in body)
      refs.push(nonempty(body.instructions, "RECORD_REFERENCE", "Instructions reference"));
    historyValue(body.history);
    if (typeof body.qualifyTools !== "boolean") fail("MESSAGES", "qualifyTools must be boolean.");
    if ("tools" in body) {
      try {
        validateToolSnapshot(body.tools as ToolSnapshot);
      } catch (error) {
        fail("TOOLS", error instanceof Error ? error.message : "Invalid tool snapshot.");
      }
    }
    if ("outputSchema" in body) object(body.outputSchema, "OUTPUT_SCHEMA", "Output schema");
  } else fail("OPERATION_KIND", "Unsupported operation kind.");
  if (refs.some((id) => !Object.hasOwn(records, id)))
    fail("RECORD_REFERENCE", "Operation refers to a missing semantic record.");
  if (new Set(refs).size !== Object.keys(records).length)
    fail("RECORD_REFERENCE", "Operation contains unreferenced semantic records.");
  const { fingerprint, ...data } = value;
  if (fingerprint !== hash(data)) fail("OPERATION_FINGERPRINT", "Operation fingerprint mismatch.");
  return freeze(value as OperationRecord);
}
export const serializeOperation = (value: OperationRecord): string =>
  canonicalJson(parseOperation(value));

function consumerResult(input: unknown, context: ConsumerAdapterInput): ConsumerAdapterResult {
  const value = object(readJson(input, "ADAPTER_RESULT"), "ADAPTER_RESULT", "Adapter result");
  fields(value, ["payload", "mappings", "decisions"], "ADAPTER_RESULT");
  if (!("payload" in value) || !Array.isArray(value.mappings) || !Array.isArray(value.decisions))
    fail("ADAPTER_RESULT", "Adapters return a JSON payload, mappings, and decisions.");
  for (const decision of value.decisions as unknown[])
    object(decision, "ADAPTER_RESULT", "Adapter decision");
  const bindings = new Map(context.bindings.map((binding) => [binding.key, binding]));
  for (const input of value.mappings as unknown[]) {
    const map = object(input, "ADAPTER_MAPPING", "Delivery mapping");
    fields(
      map,
      ["path", "binding", "record", "part", "start", "end", "relation", "source", "origin"],
      "ADAPTER_MAPPING",
    );
    if (!Array.isArray(map.path)) fail("ADAPTER_MAPPING", "Mapping path must be an array.");
    let addressed = value.payload;
    for (const segment of map.path as unknown[]) {
      const valid = Array.isArray(addressed)
        ? typeof segment === "number" && Number.isSafeInteger(segment) && segment >= 0
        : addressed !== null && typeof addressed === "object" && typeof segment === "string";
      if (!valid || !Object.hasOwn(addressed as object, segment as string | number))
        fail("ADAPTER_MAPPING", "Mapping path must address an own payload field or array item.");
      addressed = (addressed as Record<string | number, unknown>)[segment as string | number];
    }
    const binding = bindings.get(nonempty(map.binding, "ADAPTER_MAPPING", "Mapping binding"));
    if (!binding || map.record !== binding.record)
      fail("ADAPTER_MAPPING", "Mapping must identify its binding's semantic record.");
    const part =
      "part" in map ? binding?.compiled.parts.find((part) => part.id === map.part) : undefined;
    if ("part" in map && !part)
      fail("ADAPTER_MAPPING", "Mapping part is absent from its bound record.");
    const ranged = "start" in map || "end" in map;
    if (
      ranged &&
      (typeof addressed !== "string" ||
        !Number.isSafeInteger(map.start) ||
        !Number.isSafeInteger(map.end) ||
        (map.start as number) < 0 ||
        (map.end as number) < (map.start as number) ||
        (map.end as number) > addressed.length)
    )
      fail(
        "ADAPTER_MAPPING",
        "Text bounds must be a valid half-open UTF-16 range in the addressed string.",
      );
    if (map.relation === "copy") {
      if (
        !ranged ||
        part?.type !== "text" ||
        (addressed as string).slice(map.start as number, map.end as number) !== part.text
      )
        fail("ADAPTER_MAPPING", "A copy mapping must exactly match the full bound text part.");
    } else if (map.relation === "slice") {
      const source = object(map.source, "ADAPTER_MAPPING", "Slice source");
      fields(source, ["start", "end"], "ADAPTER_MAPPING");
      if (
        !ranged ||
        part?.type !== "text" ||
        !Number.isSafeInteger(source.start) ||
        !Number.isSafeInteger(source.end) ||
        (source.start as number) < 0 ||
        (source.end as number) > part.text.length ||
        (addressed as string).slice(map.start as number, map.end as number) !==
          part.text.slice(source.start as number, source.end as number)
      )
        fail("ADAPTER_MAPPING", "A slice mapping must exactly match its source range of the part.");
    } else if (map.relation === "asset-reference") {
      if (part?.type !== "image")
        fail("ADAPTER_MAPPING", "Asset-reference mappings require an image part.");
    } else if (map.relation !== "generated")
      fail("ADAPTER_MAPPING", "Unsupported mapping relation.");
    if ("origin" in map) object(map.origin, "ADAPTER_MAPPING", "Mapping origin");
  }
  return freeze(value as unknown as ConsumerAdapterResult);
}

/** Pure delivery lowering. Assets are explicit prepared representations; no fetching or sending. */
export function lowerOperation(
  input: OperationRecord,
  target: Target,
  assets: AssetBindings = {},
  adapters: readonly ConsumerAdapter[] = [],
): PreparedDelivery {
  const record = parseOperation(input);
  const body = record.operation;
  const ownedTarget = targetValue(readJson(target, "TARGET_KIND"));
  const ownedAssets = assetValues(readJson(assets, "ASSET_BINDING"));
  target = ownedTarget;
  const mappings: DeliveryMap[] = [];
  const decisions: JsonObject[] = [];
  const compiled = new Map<string, CompiledPrompt>();
  const get = (id: string) => {
    let result = compiled.get(id);
    if (!result) {
      result = rehydrate(record.records[id]);
      compiled.set(id, result);
    }
    return result;
  };
  const bindingFor = (id: string, digest?: string): AssetBinding => {
    if (!Object.hasOwn(ownedAssets, id))
      return fail("ASSET_BINDING", `Missing prepared representation for asset ${id}.`);
    const binding = ownedAssets[id];
    if (
      !binding ||
      !["url", "file", "path", "caption"].includes(binding.kind) ||
      typeof binding.value !== "string" ||
      !binding.value
    )
      return fail("ASSET_BINDING", `Invalid representation for asset ${id}.`);
    if (digest && binding.digest !== digest)
      return fail("ASSET_REVISION", `Asset ${id} needs a binding for its recorded digest.`);
    return binding;
  };
  const text = (
    id: string,
    binding: string,
    path: (string | number)[],
    allowReferences = false,
  ): string => {
    let output = "";
    for (const part of get(id).parts) {
      const start = output.length;
      if (part.type === "text") output += part.text;
      else {
        if (!allowReferences)
          return fail(
            "TEXT_ONLY",
            "This session/instruction field requires text; select an explicit text projection first.",
          );
        const reference = bindingFor(part.asset.id, part.asset.digest);
        if (!["path", "url", "caption"].includes(reference.kind))
          return fail(
            "ASSET_POLICY",
            "Channel media needs a textual path, URL, or caption policy.",
          );
        const label = reference.label ?? "image";
        if (
          reference.kind !== "caption" &&
          (/[\r\n[\]]/.test(label) || /[\r\n[\]]/.test(reference.value))
        )
          return fail(
            "ASSET_REFERENCE",
            "Bracket asset references cannot contain newlines or brackets.",
          );
        output +=
          reference.kind === "caption"
            ? reference.value
            : `[${label} located at ${reference.value}]`;
        decisions.push({
          kind: "asset-reference",
          asset: part.asset.id,
          part: part.id,
          policy: reference.kind,
          record: id,
          representation: reference.value,
        });
      }
      mappings.push({
        path,
        binding,
        record: id,
        part: part.id,
        start,
        end: output.length,
        relation: part.type === "text" ? "copy" : "asset-reference",
      });
    }
    return output;
  };
  /** One chunk of a partitioned record, as the text an append carries. */
  const chunkText = (
    id: string,
    binding: string,
    path: (string | number)[],
    chunk: ChunkReference,
  ): string => {
    const slices = chunksOf(get(id));
    if (slices.length !== chunk.count)
      return fail(
        "CHUNK_COUNT_MISMATCH",
        `The record partitions into ${slices.length} chunks, not ${chunk.count}.`,
      );
    let output = "";
    for (const part of slices[chunk.index].parts) {
      if (part.type !== "text")
        return fail("TEXT_ONLY", "An append carries text; a chunk with an image cannot be sent.");
      const start = output.length;
      output += part.text;
      mappings.push({
        path,
        binding,
        record: id,
        part: part.part,
        start,
        end: output.length,
        relation: "slice",
        source: { start: part.start, end: part.end },
      });
    }
    decisions.push({ kind: "chunk", record: id, index: chunk.index, count: chunk.count });
    return output;
  };
  const content = (
    id: string,
    binding: string,
    path: (string | number)[],
    role: "user" | "assistant",
    realtime: boolean,
  ): JsonValue[] =>
    get(id).parts.map((part, index): JsonValue => {
      const partPath = [...path, index];
      if (part.type === "text") {
        mappings.push({
          path: [...partPath, "text"],
          binding,
          record: id,
          part: part.id,
          start: 0,
          end: part.text.length,
          relation: "copy",
        });
        return {
          // Newly authored user/assistant messages use the Responses input-message shape.
          // Actual output_text items (annotations, IDs, status, phase) belong to opaque replay.
          type: "input_text",
          text: part.text,
        };
      }
      if (role !== "user")
        return fail("ASSISTANT_IMAGE", "This profile supports images only in user input.");
      const asset = bindingFor(part.asset.id, part.asset.digest);
      if (asset.kind !== "url" && !(asset.kind === "file" && !realtime))
        return fail(
          "ASSET_POLICY",
          "This profile needs image URL/data or a supported uploaded file binding.",
        );
      if (realtime && !/^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(asset.value))
        return fail(
          "ASSET_POLICY",
          "Realtime image input requires host-resolved PNG/JPEG bytes as a base64 data URI.",
        );
      const field = asset.kind === "url" ? "image_url" : "file_id";
      mappings.push({
        path: [...partPath, field],
        binding,
        record: id,
        part: part.id,
        relation: "asset-reference",
      });
      decisions.push({
        kind: "asset-reference",
        asset: part.asset.id,
        record: id,
        part: part.id,
        policy: asset.kind,
        representation: asset.value,
      });
      return {
        type: "input_image",
        [field]: asset.value,
        ...(!realtime ? { detail: "auto" } : {}),
      };
    });
  let payload: JsonValue;
  if (body.kind === "custom") {
    if (
      target.kind !== "custom" ||
      target.adapter.name !== body.adapter.name ||
      target.adapter.version !== body.adapter.version
    )
      return fail(
        "ADAPTER_TARGET",
        "Consumer operation and target require the same exact adapter identity.",
      );
    if (!Array.isArray(adapters))
      return fail("ADAPTER_REGISTRY", "Supply an explicit array of consumer adapters.");
    const candidates = adapters.filter((adapter) => {
      if (!adapter || typeof adapter !== "object" || typeof adapter.lower !== "function")
        return fail(
          "ADAPTER_REGISTRY",
          "Each consumer adapter needs an identity and lowering function.",
        );
      const identity = adapterIdentity(readJson(adapter.identity, "ADAPTER_IDENTITY"));
      return identity.name === body.adapter.name && identity.version === body.adapter.version;
    });
    if (!candidates.length)
      return fail(
        "ADAPTER_UNAVAILABLE",
        `No adapter ${body.adapter.name}@${body.adapter.version} was supplied.`,
      );
    if (candidates.length !== 1)
      return fail(
        "ADAPTER_AMBIGUOUS",
        "An adapter identity must have exactly one supplied implementation.",
      );
    const capabilities = adapterCapabilities(candidates[0].capabilities);
    if (!capabilities.actions.includes(body.action))
      return fail("ADAPTER_CAPABILITY", `Adapter does not declare action ${body.action}.`);
    const context: ConsumerAdapterInput = freeze({
      operation: body,
      options: target.options,
      bindings: body.bindings.map((binding) => ({
        key: binding.key,
        record: binding.content,
        compiled: get(binding.content),
      })),
      assets: ownedAssets,
    });
    for (const binding of context.bindings) {
      for (const part of binding.compiled.parts) {
        if (!capabilities.content.includes(part.type))
          return fail("ADAPTER_CAPABILITY", `Adapter does not declare ${part.type} content.`);
        if (part.type === "image") {
          const asset = bindingFor(part.asset.id, part.asset.digest);
          if (!capabilities.assets.includes(asset.kind))
            return fail(
              "ASSET_POLICY",
              `Adapter does not declare ${asset.kind} asset representations.`,
            );
        }
      }
    }
    let lowered: ConsumerAdapterResult;
    try {
      lowered = candidates[0].lower(context);
    } catch (error) {
      if (error instanceof PromptError) throw error;
      return fail(
        "ADAPTER_FAILED",
        error instanceof Error ? error.message : "Consumer adapter failed.",
      );
    }
    const result = consumerResult(lowered, context);
    payload = result.payload;
    mappings.push(...result.mappings);
    decisions.push(...result.decisions);
  } else if (body.kind === "channel") {
    if (target.kind !== "claude-channel/1")
      return fail("TARGET_KIND", "Channel operations require a channel target.");
    payload = {
      method: "notifications/claude/channel",
      params: { content: text(body.content, "push", ["params", "content"], true), meta: body.meta },
    };
  } else if (body.kind === "session") {
    if (target.kind !== "openai-realtime/1" && target.kind !== "live-session/1")
      return fail("TARGET_KIND", "Session operations require a session target.");
    const path =
      body.action === "update"
        ? ["session", "instructions"]
        : body.action === "connect"
          ? ["instructions"]
          : body.action === "respond"
            ? ["response", "instructions"]
            : ["content"];
    if (body.action === "update" || body.action === "connect") {
      if (target.kind === "live-session/1")
        return fail(
          "SESSION_CAPABILITY",
          "The live session profile is append-only; its session config is the consumer's own operation.",
        );
      // The host's block as captured, the instructions derived from the record.
      const block: JsonObject = {
        type: "realtime",
        ...(body.session ?? {}),
        ...(body.content !== null ? { instructions: text(body.content, body.action, path) } : {}),
      };
      payload =
        body.action === "update"
          ? { type: "session.update", event_id: body.eventId, session: block }
          : block;
    } else if (body.action.startsWith("append-")) {
      if (target.kind !== "live-session/1")
        return fail(
          "SESSION_CAPABILITY",
          "OpenAI Realtime has no append-instructions operation in this profile. Supply a new semantic replacement explicitly.",
        );
      payload = {
        type: `session.${body.action.slice(7)}.append`,
        event_id: body.eventId,
        delegation_id: body.delegationId,
        content:
          body.chunk === undefined
            ? text(body.content as string, body.action, path)
            : chunkText(body.content as string, body.action, path, body.chunk),
      };
    } else if (body.action === "respond") {
      payload = {
        type: "response.create",
        event_id: body.eventId,
        response: { instructions: text(body.content as string, body.action, path) },
      };
    } else {
      if (target.kind !== "openai-realtime/1")
        return fail(
          "SESSION_CAPABILITY",
          "Live input uses its own protocol; this profile currently covers appends and per-response instructions only.",
        );
      payload = {
        type: "conversation.item.create",
        event_id: body.eventId,
        item: {
          type: "message",
          role: "user",
          content: content(body.content as string, "input", ["item", "content"], "user", true),
        },
      };
    }
  } else {
    if (target.kind !== "openai-responses/1" || typeof target.model !== "string" || !target.model)
      return fail(
        "TARGET_KIND",
        "Responses delegation requires a model-specific Responses target.",
      );
    const input: JsonValue[] =
      body.history.kind === "provider-items" ? [...body.history.items] : [];
    for (const message of body.messages) {
      const index = input.length;
      if (message.role === "assistant") {
        if (get(message.content).parts.some((part) => part.type === "image"))
          return fail("ASSISTANT_IMAGE", "This profile supports images only in user input.");
        // Authored examples use EasyInputMessage's string content. Real assistant output
        // items (IDs/status/annotations/phase) remain untouched in opaque history.
        input.push({
          role: "assistant",
          content: text(message.content, message.key, ["input", index, "content"]),
        });
        continue;
      }
      input.push({
        role: message.role,
        content: content(
          message.content,
          message.key,
          ["input", index, "content"],
          message.role,
          false,
        ),
      });
    }
    const extra: Record<string, JsonValue> = {};
    if (body.history.kind === "remote")
      extra[
        body.history.reference.kind === "conversation" ? "conversation" : "previous_response_id"
      ] = body.history.reference.id;
    if (body.instructions)
      extra.instructions = text(body.instructions, "instructions", ["instructions"]);
    if (body.tools) {
      const projected = projectToolSchemas(body.tools, body.qualifyTools);
      extra.tools = projected.map(({ tool }) => tool);
      for (const [i, item] of projected.entries())
        mappings.push({
          path: ["tools", i],
          binding: "tools",
          record: body.tools.fingerprint,
          relation: "generated",
          origin: item.origin,
        });
    }
    if (body.outputSchema)
      extra.text = {
        format: { type: "json_schema", name: "response", strict: false, schema: body.outputSchema },
      };
    if (body.toolChoice !== undefined) extra.tool_choice = body.toolChoice;
    if (body.reasoning !== undefined) extra.reasoning = body.reasoning;
    if (body.store !== undefined) extra.store = body.store;
    payload = { model: target.model, input, ...extra };
  }
  return freeze({
    kind: "aiui.prompt.delivery",
    schemaVersion: 1,
    status: "prepared-not-sent",
    lowerer: "aiui-prompts-delivery/1.0.0",
    operation: record.fingerprint,
    target: ownedTarget,
    assets: ownedAssets,
    payload: copyJson(payload),
    mappings,
    decisions,
  });
}

/** Wire data is separate from semantic storage and preserves exactly what transport captured. */
export function parseWire(input: unknown): WireRecord {
  const value = object(readJson(input, "WIRE_JSON"), "WIRE_SHAPE", "Wire record");
  if (
    value.kind !== "aiui.prompt.wire" ||
    value.schemaVersion !== 1 ||
    value.lowerer !== "aiui-prompts-delivery/1.0.0"
  )
    fail(
      "WIRE_VERSION",
      "Unsupported wire schema or lowerer; cannot rederive using latest silently.",
    );
  fields(
    value,
    [
      "kind",
      "schemaVersion",
      "status",
      "operation",
      "lowerer",
      "target",
      "assets",
      "payload",
      "capturedAt",
      "transportId",
    ],
    "WIRE_SHAPE",
  );
  if (value.status !== "captured") fail("WIRE_SHAPE", "Wire status must be captured.");
  nonempty(value.operation, "WIRE_OPERATION", "Operation fingerprint");
  targetValue(value.target);
  assetValues(value.assets);
  if (!("payload" in value)) fail("WIRE_SHAPE", "Wire payload is required.");
  if (
    typeof value.capturedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value.capturedAt,
    ) ||
    !Number.isFinite(Date.parse(value.capturedAt))
  )
    fail("CAPTURE_TIME", "A wire capture needs an explicit valid ISO timestamp.");
  if ("transportId" in value) nonempty(value.transportId, "WIRE_SHAPE", "Transport ID");
  return freeze(value as unknown as WireRecord);
}
export const serializeWire = (value: WireRecord): string => canonicalJson(parseWire(value));

/** Called by transport with what actually left, not automatically by preparation. */
export function captureWire(
  prepared: PreparedDelivery,
  actualPayload: JsonValue,
  options: { capturedAt: string; transportId?: string },
): WireRecord {
  const delivery = object(
    readJson(prepared, "DELIVERY_SHAPE"),
    "DELIVERY_SHAPE",
    "Prepared delivery",
  );
  fields(
    delivery,
    [
      "kind",
      "schemaVersion",
      "status",
      "lowerer",
      "operation",
      "target",
      "assets",
      "payload",
      "mappings",
      "decisions",
    ],
    "DELIVERY_SHAPE",
  );
  if (
    delivery.kind !== "aiui.prompt.delivery" ||
    delivery.schemaVersion !== 1 ||
    delivery.status !== "prepared-not-sent"
  )
    fail("DELIVERY_SHAPE", "Expected a prepared delivery record.");
  const metadata = object(readJson(options, "WIRE_SHAPE"), "WIRE_SHAPE", "Wire capture options");
  fields(metadata, ["capturedAt", "transportId"], "WIRE_SHAPE");
  return parseWire({
    kind: "aiui.prompt.wire",
    schemaVersion: 1,
    status: "captured",
    operation: delivery.operation,
    lowerer: delivery.lowerer,
    target: delivery.target,
    assets: delivery.assets,
    payload: actualPayload,
    ...metadata,
  });
}
export function verifyWire(
  operation: OperationRecord,
  input: WireRecord,
  adapters: readonly ConsumerAdapter[] = [],
): { equal: boolean; expected: JsonValue; actual: JsonValue } {
  const wire = parseWire(input);
  const record = parseOperation(operation);
  if (record.fingerprint !== wire.operation)
    fail("WIRE_OPERATION", "Wire record belongs to another semantic operation.");
  const expected = lowerOperation(record, wire.target, wire.assets, adapters).payload;
  return freeze({
    equal: canonicalJson(expected) === canonicalJson(wire.payload),
    expected,
    actual: copyJson(wire.payload),
  });
}
