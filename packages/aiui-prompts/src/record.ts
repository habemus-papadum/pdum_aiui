import {
  canonicalJson,
  copyJson,
  freeze,
  type JsonObject,
  type JsonValue,
  sha256,
} from "./json.ts";
import {
  COMPILER,
  type CompileOptions,
  type Decision,
  type Definition,
  type Diagnostic,
  type FactObservation,
  Group,
  type Placement,
  type Predicate,
  PromptError,
  type PromptNode,
  type PromptValue,
  RECORD_KIND,
  SCHEMA_VERSION,
  type SemanticRecord,
} from "./model.ts";

import { type ToolSnapshot, validateToolSnapshot } from "./tools-data.ts";

export const semanticFingerprint = (value: unknown): string =>
  `sha256:${sha256(canonicalJson(value))}`;
export function occurrenceId(parent: string, edge: Placement, index: number | string): string {
  return `${parent}/${edge.key === undefined ? index : `key:${encodeURIComponent(edge.key)}`}`;
}
export function childPlacements(definition: Definition): readonly Placement[] {
  if ("children" in definition) return definition.children ?? [];
  if (definition.kind === "choice")
    return [definition.full, ...(definition.short ? [definition.short] : [])];
  if (definition.kind === "case")
    return [...definition.branches.map((branch) => branch.value), definition.fallback];
  return [];
}
function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new PromptError("INVALID_RECORD", `Expected ${label} object.`);
  return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, allowed: readonly string[], label: string) {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new PromptError("INVALID_RECORD", `Unknown ${label} field: ${unknown}`);
}
function string(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string")
    throw new PromptError("INVALID_RECORD", `Expected ${label} string.`);
}
function identifier(value: unknown, label: string) {
  string(value, label);
  if (!value.length) throw new PromptError("INVALID_RECORD", `${label} cannot be empty.`);
}
function array(value: unknown, label: string): asserts value is unknown[] {
  if (!Array.isArray(value)) throw new PromptError("INVALID_RECORD", `Expected ${label} array.`);
}
function predicate(input: unknown, depth = 0) {
  if (depth > 100) throw new PromptError("INVALID_RECORD", "Predicate nesting exceeds 100.");
  const value = object(input, "predicate");
  if (value.op === "not") {
    fields(value, ["op", "predicate"], "predicate");
    predicate(value.predicate, depth + 1);
    return;
  }
  if (value.op === "all" || value.op === "any") {
    fields(value, ["op", "predicates"], "predicate");
    array(value.predicates, "predicates");
    for (const child of value.predicates) predicate(child, depth + 1);
    return;
  }
  if (!["eq", "ne", "gt", "gte", "lt", "lte", "exists"].includes(value.op as string))
    throw new PromptError("INVALID_RECORD", "Unknown predicate operation.");
  fields(value, value.op === "exists" ? ["op", "path"] : ["op", "path", "value"], "predicate");
  identifier(value.path, "fact path");
  if (
    (value.path as string)
      .split(".")
      .some((part) => !part || ["__proto__", "prototype", "constructor"].includes(part))
  )
    throw new PromptError("INVALID_RECORD", "Invalid fact path.");
  if (value.op !== "exists" && !("value" in value))
    throw new PromptError("INVALID_RECORD", "Predicate value is required.");
  if (["gt", "gte", "lt", "lte"].includes(value.op as string) && typeof value.value !== "number")
    throw new PromptError("INVALID_RECORD", "Ordered predicates require numeric values.");
}
function placement(input: unknown) {
  const value = object(input, "placement");
  fields(value, ["definition", "key", "label", "origin", "origins"], "placement");
  identifier(value.definition, "definition reference");
  if ("key" in value) identifier(value.key, "placement key");
  if ("label" in value) string(value.label, "placement label");
  if ("origin" in value) object(value.origin, "origin");
  if ("origins" in value) {
    array(value.origins, "placement origins");
    for (const origin of value.origins) object(origin, "origin");
  }
}
function validateDefinition(input: unknown) {
  const value = object(input, "definition");
  identifier(value.id, "definition id");
  if ("label" in value) string(value.label, "label");
  if ("origin" in value) object(value.origin, "origin");
  const allowed = ["id", "kind", "label", "origin"];
  const add = (...keys: string[]) => fields(value, [...allowed, ...keys], "definition");
  if (
    ["prompt", "group", "paragraph", "section", "math", "join", "xml", "elide", "chunk"].includes(
      value.kind as string,
    ) ||
    (value.kind === "marker" && "children" in value)
  ) {
    array(value.children, "children");
    for (const edge of value.children) placement(edge);
    const keys = value.children
      .map((edge) => (edge as Placement).key)
      .filter((key) => key !== undefined);
    if (new Set(keys).size !== keys.length)
      throw new PromptError("DUPLICATE_KEY", "Sibling placement keys must be unique.");
  }
  switch (value.kind) {
    case "prompt":
    case "group":
    case "paragraph":
      add("children");
      break;
    case "section":
      add("children", "title", "keepEmpty");
      string(value.title, "section title");
      if (/[\r\n]/.test(value.title))
        throw new PromptError("INVALID_RECORD", "Section titles must be a single line.");
      if (typeof value.keepEmpty !== "boolean")
        throw new PromptError("INVALID_RECORD", "keepEmpty must be boolean.");
      break;
    case "text":
      add("value");
      string(value.value, "text value");
      break;
    case "math":
      add("children", "mode");
      if (!["inline", "display"].includes(value.mode as string))
        throw new PromptError("INVALID_RECORD", "Unknown math mode.");
      break;
    case "image": {
      add("asset");
      const asset = object(value.asset, "asset");
      fields(
        asset,
        ["id", "uri", "mimeType", "alt", "width", "height", "revision", "digest", "metadata"],
        "asset",
      );
      identifier(asset.id, "asset id");
      for (const key of ["uri", "mimeType", "alt", "revision", "digest"])
        if (key in asset) string(asset[key], `asset ${key}`);
      for (const key of ["width", "height"])
        if (key in asset && (typeof asset[key] !== "number" || (asset[key] as number) <= 0))
          throw new PromptError("INVALID_RECORD", `Asset ${key} must be positive.`);
      if ("metadata" in asset) object(asset.metadata, "asset metadata");
      break;
    }
    case "join":
      add("children", "separator");
      string(value.separator, "separator");
      break;
    case "xml": {
      add("children", "tag", "attributes");
      string(value.tag, "XML tag");
      const names = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
      if (!names.test(value.tag)) throw new PromptError("INVALID_RECORD", "Invalid XML tag name.");
      for (const [key, attribute] of Object.entries(object(value.attributes, "XML attributes"))) {
        if (!names.test(key))
          throw new PromptError("INVALID_RECORD", "Invalid XML attribute name.");
        string(attribute, "XML attribute");
      }
      break;
    }
    case "choice":
      add("name", "full", "short");
      identifier(value.name, "choice name");
      placement(value.full);
      if ("short" in value) placement(value.short);
      break;
    case "case": {
      add("name", "branches", "fallback");
      identifier(value.name, "case name");
      array(value.branches, "branches");
      for (const input of value.branches) {
        const branch = object(input, "branch");
        fields(branch, ["when", "value", "label"], "branch");
        predicate(branch.when);
        placement(branch.value);
        if ("label" in branch) string(branch.label, "branch label");
      }
      placement(value.fallback);
      break;
    }
    case "elide":
      add("children", "unit", "limit", "marker", "keep");
      if (
        !["characters", "lines", "items", "tokens"].includes(value.unit as string) ||
        !Number.isSafeInteger(value.limit) ||
        (value.limit as number) < 0
      )
        throw new PromptError(
          "INVALID_RECORD",
          "Elision needs a supported unit and nonnegative safe integer limit.",
        );
      string(value.marker, "elision marker");
      if (value.keep !== "first" && value.keep !== "last")
        throw new PromptError("INVALID_RECORD", "Elision keeps first or last.");
      break;
    case "chunk": {
      add("children", "unit", "limit", "boundaries", "marker");
      if (
        !["tokens", "characters"].includes(value.unit as string) ||
        !Number.isSafeInteger(value.limit) ||
        (value.limit as number) < 0
      )
        throw new PromptError(
          "INVALID_RECORD",
          "A chunk needs a supported unit and nonnegative safe integer limit.",
        );
      array(value.boundaries, "chunk boundaries");
      if (
        !value.boundaries.length ||
        new Set(value.boundaries).size !== value.boundaries.length ||
        value.boundaries.some(
          (kind) =>
            !["paragraph", "line", "sentence", "word", "character"].includes(kind as string),
        )
      )
        throw new PromptError(
          "INVALID_RECORD",
          "Chunk boundaries are a nonempty list of distinct supported kinds.",
        );
      string(value.marker, "chunk marker");
      break;
    }
    case "tools": {
      add("toolSnapshot", "projection");
      try {
        validateToolSnapshot(value.toolSnapshot as ToolSnapshot);
      } catch (error) {
        throw new PromptError("INVALID_TOOLS", String(error));
      }
      const options = object(value.projection, "tool projection");
      fields(options, ["style", "qualify", "maxChars"], "tool projection");
      if (!["brief", "capabilities", "json"].includes(options.style as string))
        throw new PromptError("INVALID_TOOLS", "Unknown tool projection.");
      if ("qualify" in options && typeof options.qualify !== "boolean")
        throw new PromptError("INVALID_TOOLS", "qualify must be boolean.");
      if (
        "maxChars" in options &&
        (options.style !== "brief" ||
          !Number.isSafeInteger(options.maxChars) ||
          (options.maxChars as number) < 0)
      )
        throw new PromptError(
          "INVALID_TOOLS",
          "Tool maxChars requires a brief projection and a nonnegative integer.",
        );
      break;
    }
    case "marker":
      add("name", "fields", "children");
      identifier(value.name, "marker name");
      object(value.fields, "marker fields");
      break;
    default:
      throw new PromptError("INVALID_RECORD", `Unknown definition kind: ${String(value.kind)}`);
  }
}
function fact(context: JsonObject, path: string): FactObservation {
  let value: JsonValue = context;
  for (const segment of path.split(".")) {
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, segment))
      return { path, present: false, value: null };
    value = (value as JsonObject)[segment];
  }
  return { path, present: true, value };
}
function evaluate(
  test: Predicate,
  context: JsonObject,
  facts: Map<string, FactObservation>,
): boolean {
  if (test.op === "all" || test.op === "any") {
    const values = test.predicates.map((child) => evaluate(child, context, facts));
    return test.op === "all" ? values.every(Boolean) : values.some(Boolean);
  }
  if (test.op === "not") return !evaluate(test.predicate, context, facts);
  if (!("path" in test)) return false;
  const seen = fact(context, test.path);
  facts.set(test.path, seen);
  if (test.op === "exists") return seen.present;
  if (test.op === "eq")
    return seen.present && canonicalJson(seen.value) === canonicalJson(test.value);
  if (test.op === "ne")
    return seen.present && canonicalJson(seen.value) !== canonicalJson(test.value);
  if (!seen.present || typeof seen.value !== "number") return false;
  if (test.op === "gt") return seen.value > test.value;
  if (test.op === "gte") return seen.value >= test.value;
  if (test.op === "lt") return seen.value < test.value;
  return test.op === "lte" && seen.value <= test.value;
}

/** Selection evaluation is pure and does not render any text. All authored branches remain recorded. */
export function deriveDecisions(
  record: Pick<SemanticRecord, "root" | "definitions" | "context" | "options">,
): readonly Decision[] {
  const definitions = new Map(record.definitions.map((value) => [value.id, value]));
  const decisions: Decision[] = [];
  let count = 0;
  function walk(edge: Placement, id: string, depth: number) {
    if (++count > 50000 || depth > 200)
      throw new PromptError("GRAPH_LIMIT", "Prompt occurrence expansion exceeds supported limits.");
    const def = definitions.get(edge.definition);
    if (!def) throw new PromptError("INVALID_RECORD", `Dangling definition ${edge.definition}.`);
    if (def.kind === "choice") {
      const scoped = `${id}:${def.name}`;
      const selection = record.options.selection;
      const selected = Object.hasOwn(selection, scoped)
        ? selection[scoped]
        : Object.hasOwn(selection, def.name)
          ? selection[def.name]
          : "full";
      if (selected === "short" && !def.short)
        throw new PromptError("MISSING_VARIANT", `Choice ${def.name} has no short variant.`, id);
      decisions.push({ occurrence: id, kind: "choice", name: def.name, selected });
      const child = selected === "omit" ? undefined : selected === "short" ? def.short : def.full;
      if (child) walk(child, occurrenceId(id, child, selected), depth + 1);
    } else if (def.kind === "case") {
      const facts = new Map<string, FactObservation>();
      let index = -1;
      for (const [i, branch] of def.branches.entries())
        if (evaluate(branch.when, record.context, facts)) {
          index = i;
          break;
        }
      const selected = index < 0 ? "fallback" : String(index);
      decisions.push({
        occurrence: id,
        kind: "case",
        name: def.name,
        selected,
        facts: [...facts.values()],
      });
      const child = index < 0 ? def.fallback : def.branches[index].value;
      walk(child, occurrenceId(id, child, selected), depth + 1);
    } else {
      for (const [i, child] of childPlacements(def).entries())
        walk(child, occurrenceId(id, child, i), depth + 1);
    }
  }
  walk(record.root, "o", 0);
  return decisions;
}
/**
 * A plain name may address any authored Choice, including an inactive Case branch. A scoped
 * selector must identify an authored placement path. Dormant scoped paths remain valid, so
 * retaining an inner selection does not prevent an enclosing Choice from being omitted.
 */
function validateSelections(record: Pick<SemanticRecord, "root" | "definitions" | "options">) {
  const definitions = new Map(record.definitions.map((definition) => [definition.id, definition]));
  const names = new Set(
    record.definitions.flatMap((definition) =>
      definition.kind === "choice" ? [definition.name] : [],
    ),
  );
  function matches(edge: Placement, id: string, selector: string): boolean {
    const definition = definitions.get(edge.definition) as Definition;
    if (definition.kind === "choice" && selector === `${id}:${definition.name}`) return true;
    // Follow only the requested prefix, never expand all possible branch combinations.
    const children: readonly (readonly [string | number, Placement])[] =
      definition.kind === "choice"
        ? [
            ["full", definition.full],
            ...(definition.short ? [["short", definition.short] as const] : []),
          ]
        : definition.kind === "case"
          ? [
              ...definition.branches.map((branch, index) => [String(index), branch.value] as const),
              ["fallback", definition.fallback],
            ]
          : childPlacements(definition).map((child, index) => [index, child] as const);
    for (const [index, child] of children) {
      const childId = occurrenceId(id, child, index);
      if (
        (selector.startsWith(`${childId}/`) || selector.startsWith(`${childId}:`)) &&
        matches(child, childId, selector)
      )
        return true;
    }
    return false;
  }
  for (const selector of Object.keys(record.options.selection)) {
    if (!names.has(selector) && !matches(record.root, "o", selector)) {
      throw new PromptError(
        "UNKNOWN_SELECTION",
        `Selection ${selector} does not address an authored Choice name or placement.`,
      );
    }
  }
}
function validateShape(value: unknown): asserts value is SemanticRecord {
  const record = object(value, "record");
  if (record.kind !== RECORD_KIND)
    throw new PromptError("INVALID_RECORD", "Not an aiui prompt semantic record.");
  if (record.schemaVersion !== SCHEMA_VERSION)
    throw new PromptError(
      "UNSUPPORTED_SCHEMA",
      `Unsupported semantic schema version ${String(record.schemaVersion)}. No implicit migration is performed.`,
    );
  const compiler = object(record.compiler, "compiler");
  if (compiler.name !== COMPILER.name || compiler.version !== COMPILER.version)
    throw new PromptError(
      "UNSUPPORTED_COMPILER",
      `Compiler ${String(compiler.name)}@${String(compiler.version)} is not installed. Refusing to compile with a different version.`,
    );
  fields(compiler, ["name", "version"], "compiler");
  fields(
    record,
    [
      "kind",
      "schemaVersion",
      "compiler",
      "fingerprint",
      "root",
      "definitions",
      "context",
      "options",
      "decisions",
    ],
    "record",
  );
  identifier(record.fingerprint, "fingerprint");
  placement(record.root);
  array(record.definitions, "definitions");
  if (record.definitions.length > 10000)
    throw new PromptError("GRAPH_LIMIT", "A record supports at most 10000 definitions.");
  for (const def of record.definitions) validateDefinition(def);
  object(record.context, "context");
  const options = object(record.options, "options");
  fields(options, ["selection"], "options");
  for (const value of Object.values(object(options.selection, "selection")))
    if (!["full", "short", "omit"].includes(value as string))
      throw new PromptError("INVALID_RECORD", "Unknown selection variant.");
  array(record.decisions, "decisions");
  const definitions = new Map((record.definitions as Definition[]).map((def) => [def.id, def]));
  if (definitions.size !== record.definitions.length)
    throw new PromptError("INVALID_RECORD", "Duplicate definition identifiers.");
  const active = new Set<string>();
  const visited = new Set<string>();
  function visit(edge: Placement, depth: number) {
    if (depth > 200) throw new PromptError("GRAPH_LIMIT", "Definition nesting exceeds 200.");
    if (active.has(edge.definition))
      throw new PromptError("INVALID_RECORD", "Cyclic prompt definition graph.");
    if (visited.has(edge.definition)) return;
    const def = definitions.get(edge.definition);
    if (!def) throw new PromptError("INVALID_RECORD", `Dangling definition ${edge.definition}.`);
    active.add(def.id);
    for (const child of childPlacements(def)) visit(child, depth + 1);
    active.delete(def.id);
    visited.add(def.id);
  }
  visit(record.root as Placement, 0);
  if (visited.size !== definitions.size)
    throw new PromptError("INVALID_RECORD", "Record contains unreachable definitions.");
  validateSelections(record as SemanticRecord);
}
function parse(input: unknown): SemanticRecord {
  let value: unknown;
  try {
    value = copyJson(typeof input === "string" ? JSON.parse(input) : input);
  } catch (error) {
    throw new PromptError("INVALID_JSON", error instanceof Error ? error.message : "Invalid JSON");
  }
  validateShape(value);
  const { fingerprint, ...body } = value;
  if (semanticFingerprint(body) !== fingerprint)
    throw new PromptError(
      "FINGERPRINT_MISMATCH",
      "Semantic record fingerprint does not match its contents.",
    );
  if (canonicalJson(deriveDecisions(value)) !== canonicalJson(value.decisions))
    throw new PromptError(
      "DECISION_MISMATCH",
      "Recorded decisions do not match recorded context and selection.",
    );
  return freeze(value);
}
export function parseRecord(input: unknown): SemanticRecord {
  return parse(input);
}
export function validateRecord(input: unknown): readonly Diagnostic[] {
  try {
    parse(input);
    return [];
  } catch (error) {
    return [
      error instanceof PromptError
        ? error.diagnostic
        : { code: "INVALID_RECORD", message: String(error) },
    ];
  }
}
export function serializeRecord(record: SemanticRecord): string {
  return canonicalJson(parse(record));
}

export function snapshot(value: PromptValue, options: CompileOptions = {}): SemanticRecord {
  // This initial validation examines descriptors before traversal can read a getter.
  try {
    copyJson(value);
    copyJson(options);
  } catch (error) {
    throw new PromptError("INVALID_VALUE", error instanceof Error ? error.message : String(error));
  }
  const definitions: Definition[] = [];
  const seen = new Map<object, string>();
  function edge(input: PromptValue): Placement {
    const node =
      typeof input === "string"
        ? { kind: "text" as const, value: input }
        : Array.isArray(input) || input === null || input === false
          ? Group({ children: input })
          : (input as PromptNode);
    if (!node || typeof node !== "object" || !("kind" in node))
      throw new PromptError("INVALID_CHILD", "Expected a prepared prompt value.");
    if (node.kind === "use") {
      const placed = edge(node.value);
      const origins = [
        ...(placed.origins ?? (placed.origin ? [placed.origin] : [])),
        ...(node.origin ? [copyJson(node.origin)] : []),
      ];
      return {
        ...placed,
        ...(node.key !== undefined ? { key: node.key } : {}),
        ...(node.label !== undefined ? { label: node.label } : {}),
        ...(node.origin !== undefined ? { origin: copyJson(node.origin) } : {}),
        ...(origins.length > 1 ? { origins } : {}),
      };
    }
    const existing = seen.get(node);
    if (existing) return { definition: existing };
    const id = `d${definitions.length}`;
    seen.set(node, id);
    const at = definitions.length;
    definitions.push(null as unknown as Definition);
    let definition: Definition;
    if ("children" in node)
      definition = { ...node, id, children: (node.children ?? []).map(edge) } as Definition;
    else if (node.kind === "choice") {
      const { full, short, ...rest } = node;
      definition = {
        ...rest,
        id,
        full: edge(full),
        ...(short !== undefined ? { short: edge(short) } : {}),
      };
    } else if (node.kind === "case")
      definition = {
        ...node,
        id,
        branches: node.branches.map((branch) => ({ ...branch, value: edge(branch.value) })),
        fallback: edge(node.fallback),
      };
    else definition = { ...node, id } as Definition;
    definitions[at] = definition;
    return { definition: id };
  }
  const root = edge(value);
  const basis = {
    kind: RECORD_KIND,
    schemaVersion: SCHEMA_VERSION,
    compiler: COMPILER,
    root,
    definitions,
    context: copyJson(options.context ?? {}),
    options: { selection: copyJson(options.selection ?? {}) },
  };
  // Validate the structural boundary before following predicates or expanding the DAG.
  validateShape({ ...basis, fingerprint: "pending", decisions: [] });
  const body = { ...basis, decisions: deriveDecisions(basis) };
  return freeze(copyJson({ ...body, fingerprint: semanticFingerprint(body) }));
}

/** Re-selection creates a new durable semantic record and never mutates a stored record. */
export function withRecordOptions(input: SemanticRecord, options: CompileOptions): SemanticRecord {
  const capturedOptions = copyJson(options);
  const record = parseRecord(input);
  const { fingerprint: _fingerprint, decisions: _decisions, ...old } = record;
  const basis = {
    ...old,
    context: copyJson(capturedOptions.context ?? old.context),
    options: { selection: copyJson(capturedOptions.selection ?? old.options.selection) },
  };
  validateShape({ ...basis, fingerprint: "pending", decisions: [] });
  const body = { ...basis, decisions: deriveDecisions(basis) };
  return parseRecord({ ...body, fingerprint: semanticFingerprint(body) });
}
