import { canonicalJson, copyJson, freeze, type JsonObject, sha256 } from "./json.ts";

export interface ToolDeclaration {
  readonly name: string;
  readonly description: string;
  readonly inputSchema?: JsonObject;
  readonly usage?: string;
  readonly kind?: "read" | "write";
  readonly group?: string;
}
export interface ToolKit {
  readonly ns: string;
  readonly brief?: string;
  readonly tools: readonly ToolDeclaration[];
}
export interface ToolSnapshot {
  readonly kind: "aiui.tools";
  readonly schemaVersion: 1;
  readonly fingerprint: string;
  readonly kits: readonly ToolKit[];
  readonly origin: JsonObject;
}
export interface ToolProjectionOptions {
  readonly style: "brief" | "capabilities" | "json";
  readonly qualify?: boolean;
  readonly maxChars?: number;
}
export interface ToolProjection {
  readonly segments: readonly {
    text: string;
    origin?: JsonObject;
    relation: "authored" | "generated";
  }[];
  readonly decisions: readonly {
    kind: "tool-budget";
    selected: string;
    detail: JsonObject;
  }[];
}

/** Capture declarations once. Execution callbacks never belong in a tool document. */
export function toolSnapshot(kits: readonly ToolKit[], origin: JsonObject = {}): ToolSnapshot {
  const data = copyJson({ kind: "aiui.tools" as const, schemaVersion: 1 as const, kits, origin });
  plain(data.origin, "tool origin");
  validateKits(data.kits);
  return freeze({ ...data, fingerprint: `sha256:${sha256(canonicalJson(data))}` });
}
function plain(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(`Expected object for ${label}.`);
}
function fields(value: object, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) throw new TypeError(`Unknown ${label} field ${key}.`);
}
function validateKits(kits: readonly ToolKit[]): void {
  if (!Array.isArray(kits)) throw new TypeError("Tool kits must be an array.");
  const names = new Set<string>();
  const namespaces = new Set<string>();
  for (const kit of kits) {
    plain(kit, "tool kit");
    fields(kit, ["ns", "brief", "tools"], "tool kit");
    if (typeof kit.ns !== "string" || !kit.ns || namespaces.has(kit.ns))
      throw new TypeError("Tool namespaces must be nonempty and unique.");
    namespaces.add(kit.ns);
    if (kit.brief !== undefined && typeof kit.brief !== "string")
      throw new TypeError("Invalid kit brief.");
    if (!Array.isArray(kit.tools)) throw new TypeError("Tool declarations must be an array.");
    for (const tool of kit.tools) {
      plain(tool, "tool declaration");
      fields(
        tool,
        ["name", "description", "inputSchema", "usage", "kind", "group"],
        "tool declaration",
      );
      const key = `${kit.ns}/${tool.name}`;
      if (typeof tool.name !== "string" || !tool.name || names.has(key))
        throw new TypeError(`Duplicate or invalid tool ${key}.`);
      if (
        typeof tool.description !== "string" ||
        (tool.usage !== undefined && typeof tool.usage !== "string") ||
        (tool.group !== undefined && typeof tool.group !== "string") ||
        (tool.kind !== undefined && tool.kind !== "read" && tool.kind !== "write")
      )
        throw new TypeError(`Invalid tool ${key}.`);
      if (
        tool.inputSchema !== undefined &&
        (tool.inputSchema === null ||
          Array.isArray(tool.inputSchema) ||
          typeof tool.inputSchema !== "object")
      )
        throw new TypeError(`Invalid schema for ${key}.`);
      names.add(key);
    }
  }
}
export function validateToolSnapshot(snapshot: ToolSnapshot): void {
  const value = copyJson(snapshot);
  plain(value, "tool snapshot");
  if (value.kind !== "aiui.tools" || value.schemaVersion !== 1)
    throw new TypeError("Unsupported tool snapshot schema.");
  fields(value, ["kind", "schemaVersion", "fingerprint", "kits", "origin"], "tool snapshot");
  plain(value.origin, "tool origin");
  validateKits(value.kits);
  const { fingerprint, ...data } = value;
  if (fingerprint !== `sha256:${sha256(canonicalJson(data))}`)
    throw new TypeError("Tool snapshot fingerprint mismatch.");
}
const headings = {
  read: "Read tools (call freely once the intent is clear; no confirmation needed):",
  write: "Write tools (they change the app; the result is the value actually applied):",
  other: "Other tools:",
};
const failure =
  "If a tool fails, say what failed in a few words and do not repeat the same call unchanged.";
const firstSentence = (value: string) => value.trim().split(/(?<=[.!?])\s+/)[0] ?? "";

/** Deterministic projections of structured declarations. Caps remain visible decisions. */
export function projectTools(
  snapshot: ToolSnapshot,
  options: ToolProjectionOptions,
): ToolProjection {
  validateToolSnapshot(snapshot);
  if (!["brief", "capabilities", "json"].includes(options.style))
    throw new TypeError("Unknown tool projection.");
  if (
    options.maxChars !== undefined &&
    (!Number.isSafeInteger(options.maxChars) || options.maxChars < 0)
  )
    throw new TypeError("maxChars must be a nonnegative safe integer.");
  const live = snapshot.kits.filter((kit) => kit.tools.length > 0 || (kit.brief ?? "") !== "");
  const rows = live.flatMap((kit) =>
    kit.tools.map((tool) => ({
      tool,
      ns: kit.ns,
      key: `${kit.ns}/${tool.name}`,
      name: options.qualify ? `${kit.ns}/${tool.name}` : tool.name,
    })),
  );
  if (new Set(rows.map((row) => row.name)).size !== rows.length)
    throw new TypeError("Tool projection has ambiguous names; enable qualify.");
  const origin = (field: string): JsonObject => ({
    kind: "tool-projection",
    snapshot: snapshot.fingerprint,
    field,
  });
  const segments: ToolProjection["segments"][number][] = [];
  const decisions: ToolProjection["decisions"][number][] = [];
  const append = (text: string, field?: string) => {
    if (!text) return;
    segments.push({
      text,
      relation: field ? "authored" : "generated",
      ...(field ? { origin: origin(field) } : {}),
    });
  };
  const appendLine = (text: string, field?: string) => {
    if (segments.length) append("\n");
    append(text, field);
  };
  const appendName = (row: (typeof rows)[number]) => {
    if (options.qualify) {
      append(row.ns, `${row.ns}/ns`);
      append("/");
    }
    append(row.tool.name, `${row.key}/name`);
  };
  if (options.style === "json") {
    segments.push({
      text: canonicalJson(snapshot.kits),
      relation: "generated",
      origin: origin("kits"),
    });
  } else if (options.style === "capabilities") {
    for (const kit of live)
      if (kit.brief?.trim()) {
        appendLine("- App: ");
        append(firstSentence(kit.brief), `${kit.ns}/brief`);
      }
    for (const row of rows) {
      appendLine("- ");
      appendName(row);
      append(": ");
      append(firstSentence(row.tool.description), `${row.key}/description`);
    }
    decisions.push({
      kind: "tool-budget",
      selected: "first-sentence",
      detail: { method: "sentence-boundary-whitespace/1", snapshot: snapshot.fingerprint },
    });
  } else if (live.length) {
    const omitted = new Set<string>();
    const render = () => {
      segments.length = 0;
      appendLine("Tools:");
      for (const kit of live)
        if (kit.brief?.trim()) appendLine(kit.brief.trim(), `${kit.ns}/brief`);
      for (const kind of ["read", "write", "other"] as const) {
        const selected = rows.filter((row) => (row.tool.kind ?? "other") === kind);
        if (!selected.length) continue;
        appendLine(headings[kind]);
        const groups = [...new Set(selected.map((row) => row.tool.group))];
        if (groups.includes(undefined)) {
          groups.splice(groups.indexOf(undefined), 1);
          groups.unshift(undefined);
        }
        for (const group of groups) {
          if (group !== undefined) appendLine(`${group}:`);
          for (const row of selected.filter((item) => item.tool.group === group)) {
            appendLine("- ");
            appendName(row);
            append(": ");
            append(row.tool.description, `${row.key}/description`);
            if (!omitted.has(row.key) && row.tool.usage) {
              append(" ");
              append(row.tool.usage, `${row.key}/usage`);
            }
          }
        }
      }
      if (rows.length) appendLine(failure);
      return segments.reduce((sum, segment) => sum + segment.text.length, 0);
    };
    const before = render();
    let after = before;
    if (options.maxChars !== undefined) {
      for (const row of rows
        .filter((row) => row.tool.usage)
        .sort((a, b) => (b.tool.usage?.length ?? 0) - (a.tool.usage?.length ?? 0))) {
        if (after <= options.maxChars) break;
        omitted.add(row.key);
        after = render();
      }
      decisions.push({
        kind: "tool-budget",
        selected:
          after > options.maxChars
            ? "required-over-budget"
            : omitted.size
              ? "elided-usage"
              : "full",
        detail: {
          snapshot: snapshot.fingerprint,
          unit: "utf16-code-units",
          limit: options.maxChars,
          before,
          after,
          omittedUsage: [...omitted],
          method: "longest-usage-first/1",
        },
      });
    }
  }
  if (options.style !== "brief" && options.maxChars !== undefined)
    throw new TypeError(
      "maxChars is supported for brief projections; use an explicit Elide around other projections.",
    );
  return freeze({ segments, decisions });
}

/** The vendor view keeps a declaration origin for each schema and never carries usage as a wire field. */
export function projectToolSchemas(snapshot: ToolSnapshot, qualify = false) {
  validateToolSnapshot(snapshot);
  const names = new Set<string>();
  return freeze(
    snapshot.kits.flatMap((kit) =>
      kit.tools.map((tool) => {
        const name = qualify ? `${kit.ns}_${tool.name}` : tool.name;
        if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name) || names.has(name))
          throw new TypeError(`Invalid or duplicate provider tool name: ${name}`);
        if (tool.inputSchema === undefined)
          throw new TypeError(`Tool ${kit.ns}/${tool.name} has no input schema.`);
        names.add(name);
        return {
          tool: {
            type: "function" as const,
            name,
            description: tool.description,
            parameters: tool.inputSchema,
            strict: false,
          },
          origin: originForTool(snapshot, kit.ns, tool.name),
        };
      }),
    ),
  );
}
export function originForTool(snapshot: ToolSnapshot, namespace: string, name: string): JsonObject {
  return { kind: "tool", snapshot: snapshot.fingerprint, namespace, name };
}
