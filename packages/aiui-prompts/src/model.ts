import { copyJson, freeze, type JsonObject, type JsonValue } from "./json.ts";
import type { ToolProjectionOptions, ToolSnapshot } from "./tools-data.ts";

export type { JsonObject, JsonValue } from "./json.ts";

export const RECORD_KIND = "aiui.prompt" as const;
export const SCHEMA_VERSION = 1 as const;
/** Compiler semantics are versioned independently of the workspace's distribution version. */
export const COMPILER = Object.freeze({ name: "aiui-prompts", version: "1.0.0" });
export type Origin = JsonObject;
export type Asset = Readonly<{
  id: string;
  uri?: string;
  mimeType?: string;
  alt?: string;
  width?: number;
  height?: number;
  revision?: string;
  digest?: string;
  metadata?: JsonObject;
}>;
export type Selection = Readonly<Record<string, "full" | "short" | "omit">>;
export type Predicate =
  | { readonly op: "eq" | "ne"; readonly path: string; readonly value: JsonValue }
  | { readonly op: "gt" | "gte" | "lt" | "lte"; readonly path: string; readonly value: number }
  | { readonly op: "exists"; readonly path: string }
  | { readonly op: "all" | "any"; readonly predicates: readonly Predicate[] }
  | { readonly op: "not"; readonly predicate: Predicate };
export type Placement = Readonly<{
  definition: string;
  origins?: readonly Origin[];
  key?: string;
  label?: string;
  origin?: Origin;
}>;
type Base = Readonly<{ label?: string; origin?: Origin }>;
type Spec<C> = Base &
  (
    | { readonly kind: "prompt" | "group" | "paragraph"; readonly children: readonly C[] }
    | {
        readonly kind: "section";
        readonly title: string;
        readonly keepEmpty: boolean;
        readonly children: readonly C[];
      }
    | { readonly kind: "text"; readonly value: string }
    | {
        readonly kind: "math";
        readonly mode: "inline" | "display";
        readonly children: readonly C[];
      }
    | { readonly kind: "image"; readonly asset: Asset }
    | { readonly kind: "join"; readonly separator: string; readonly children: readonly C[] }
    | {
        readonly kind: "xml";
        readonly tag: string;
        readonly attributes: Readonly<Record<string, string>>;
        readonly children: readonly C[];
      }
    | { readonly kind: "choice"; readonly name: string; readonly full: C; readonly short?: C }
    | {
        readonly kind: "case";
        readonly name: string;
        readonly branches: readonly {
          readonly when: Predicate;
          readonly value: C;
          readonly label?: string;
        }[];
        readonly fallback: C;
      }
    | {
        readonly kind: "elide";
        readonly unit: "characters" | "lines" | "items";
        readonly limit: number;
        readonly marker: string;
        readonly children: readonly C[];
      }
    | {
        readonly kind: "marker";
        readonly name: string;
        readonly fields: JsonObject;
        readonly children?: readonly C[];
      }
    | {
        readonly kind: "tools";
        readonly toolSnapshot: ToolSnapshot;
        readonly projection: ToolProjectionOptions;
      }
  );
export type PromptNode = Base &
  (
    | { readonly kind: "prompt" | "group" | "paragraph"; readonly children: readonly PromptValue[] }
    | {
        readonly kind: "section";
        readonly title: string;
        readonly keepEmpty: boolean;
        readonly children: readonly PromptValue[];
      }
    | { readonly kind: "text"; readonly value: string }
    | {
        readonly kind: "math";
        readonly mode: "inline" | "display";
        readonly children: readonly PromptValue[];
      }
    | { readonly kind: "image"; readonly asset: Asset }
    | {
        readonly kind: "join";
        readonly separator: string;
        readonly children: readonly PromptValue[];
      }
    | {
        readonly kind: "xml";
        readonly tag: string;
        readonly attributes: Readonly<Record<string, string>>;
        readonly children: readonly PromptValue[];
      }
    | {
        readonly kind: "choice";
        readonly name: string;
        readonly full: PromptValue;
        readonly short?: PromptValue;
      }
    | {
        readonly kind: "case";
        readonly name: string;
        readonly branches: readonly {
          readonly when: Predicate;
          readonly value: PromptValue;
          readonly label?: string;
        }[];
        readonly fallback: PromptValue;
      }
    | {
        readonly kind: "elide";
        readonly unit: "characters" | "lines" | "items";
        readonly limit: number;
        readonly marker: string;
        readonly children: readonly PromptValue[];
      }
    | {
        readonly kind: "marker";
        readonly name: string;
        readonly fields: JsonObject;
        readonly children?: readonly PromptValue[];
      }
    | {
        readonly kind: "tools";
        readonly toolSnapshot: ToolSnapshot;
        readonly projection: ToolProjectionOptions;
      }
    | { readonly kind: "use"; readonly value: PromptValue; readonly key?: string }
  );
export type PromptValue = PromptNode | string | null | false | readonly PromptValue[];
export type Definition = Spec<Placement> & { readonly id: string };
export type FactObservation = Readonly<{ path: string; present: boolean; value: JsonValue }>;
export type Decision = Readonly<{
  occurrence: string;
  kind: "case" | "choice" | "elide" | "tool-budget";
  name?: string;
  selected: string;
  facts?: readonly FactObservation[];
  detail?: JsonObject;
}>;
export type CompileOptions = Readonly<{ context?: JsonObject; selection?: Selection }>;
export type SemanticRecord = Readonly<{
  kind: typeof RECORD_KIND;
  schemaVersion: typeof SCHEMA_VERSION;
  compiler: typeof COMPILER;
  fingerprint: string;
  root: Placement;
  definitions: readonly Definition[];
  context: JsonObject;
  options: { readonly selection: Selection };
  decisions: readonly Decision[];
}>;
export type Diagnostic = Readonly<{ code: string; message: string; occurrence?: string }>;
export class PromptError extends Error {
  readonly diagnostic: Diagnostic;
  constructor(code: string, message: string, occurrence?: string) {
    super(message);
    this.name = "PromptError";
    this.diagnostic = { code, message, ...(occurrence ? { occurrence } : {}) };
  }
}
export type OutputPart = Readonly<
  { id: string; type: "text"; text: string } | { id: string; type: "image"; asset: Asset }
>;
export type Occurrence = Readonly<{
  id: string;
  definition: string;
  kind: Definition["kind"];
  parent?: string;
  definitionOrigin?: Origin;
  origins?: readonly Origin[];
  key?: string;
  label?: string;
  origin?: Origin;
}>;
export type Contribution = Readonly<{
  occurrence: string;
  part: string;
  start?: number;
  end?: number;
  relation: "authored" | "generated" | "escaped";
  origin?: Origin;
}>;
export type SemanticRegion = Readonly<{
  id: string;
  kind: "math" | "xml" | "marker";
  occurrence: string;
  part: string;
  start: number;
  end: number;
  mode?: "inline" | "display";
}>;
export type CompiledPrompt = Readonly<{
  recordFingerprint: string;
  compiler: typeof COMPILER;
  parts: readonly OutputPart[];
  occurrences: readonly Occurrence[];
  contributions: readonly Contribution[];
  decisions: readonly Decision[];
  diagnostics: readonly Diagnostic[];
  semanticRegions: readonly SemanticRegion[];
}>;

type Props = Base & { children?: PromptValue };
function base(props: Base): Base {
  return {
    ...(props.label !== undefined ? { label: props.label } : {}),
    ...(props.origin !== undefined ? { origin: freeze(copyJson(props.origin)) } : {}),
  };
}
function children(props: Props): readonly PromptValue[] {
  if (!Object.hasOwn(props, "children")) return [];
  const values: PromptValue[] = [];
  function add(value: PromptValue) {
    if (value === null || value === false) return;
    if (Array.isArray(value)) {
      for (const child of value) add(child);
      return;
    }
    if (
      typeof value === "string" ||
      (typeof value === "object" &&
        value !== null &&
        "kind" in value &&
        typeof value.kind === "string")
    ) {
      values.push(value);
      return;
    }
    throw new PromptError(
      "INVALID_CHILD",
      "Prompt children must be prepared strings or prompt values; undefined, numbers, promises, and functions are not supported.",
    );
  }
  add(props.children as PromptValue);
  return Object.freeze(values);
}
function sequence(kind: "prompt" | "group" | "paragraph", props: Props): PromptNode {
  return Object.freeze({ ...base(props), kind, children: children(props) });
}
export const Prompt = (props: Props = {}): PromptNode => sequence("prompt", props);
export const Group = (props: Props = {}): PromptNode => sequence("group", props);
export const Paragraph = (props: Props = {}): PromptNode => sequence("paragraph", props);
export const Section = (props: Props & { title: string; keepEmpty?: boolean }): PromptNode =>
  Object.freeze({
    ...base(props),
    kind: "section",
    title: props.title,
    keepEmpty: props.keepEmpty ?? false,
    children: children(props),
  });
export const Text = (props: Base & { value: string }): PromptNode =>
  Object.freeze({ ...base(props), kind: "text", value: props.value });
// biome-ignore lint/suspicious/noShadowRestrictedNames: Math names the public prompt component.
export const Math = (
  props: Props & { value?: string; mode?: "inline" | "display" },
): PromptNode => {
  if ("value" in props && "children" in props)
    throw new PromptError("MATH_CONTENT", "Math accepts value or children, not both.");
  return Object.freeze({
    ...base(props),
    kind: "math",
    mode: props.mode ?? "display",
    children:
      "value" in props ? Object.freeze([Text({ value: props.value as string })]) : children(props),
  });
};
export const Image = (props: Base & { asset: Asset }): PromptNode =>
  Object.freeze({ ...base(props), kind: "image", asset: freeze(copyJson(props.asset)) });
export const Join = (props: Props & { separator: string }): PromptNode =>
  Object.freeze({
    ...base(props),
    kind: "join",
    separator: props.separator,
    children: children(props),
  });
export const Xml = (
  props: Props & { tag: string; attributes?: Readonly<Record<string, string>> },
): PromptNode =>
  Object.freeze({
    ...base(props),
    kind: "xml",
    tag: props.tag,
    attributes: freeze(copyJson(props.attributes ?? {})),
    children: children(props),
  });
export const Use = (props: Base & { value: PromptValue; key?: string | number }): PromptNode =>
  Object.freeze({
    ...base(props),
    kind: "use",
    value: Array.isArray(props.value) ? Group({ children: props.value }) : props.value,
    ...(props.key !== undefined ? { key: String(props.key) } : {}),
  });
export const Choice = (props: Props & { name: string; short?: PromptValue }): PromptNode =>
  Object.freeze({
    ...base(props),
    kind: "choice",
    name: props.name,
    full: Group({ children: children(props) }),
    ...("short" in props ? { short: Group({ children: props.short as PromptValue }) } : {}),
  });
export const Case = (
  props: Base & {
    name: string;
    branches: readonly { when: Predicate; value: PromptValue; label?: string }[];
    fallback?: PromptValue;
  },
): PromptNode =>
  Object.freeze({
    ...base(props),
    kind: "case",
    name: props.name,
    branches: Object.freeze(
      props.branches.map((branch) =>
        Object.freeze({
          when: freeze(copyJson(branch.when)),
          value: Group({ children: branch.value }),
          ...(branch.label !== undefined ? { label: branch.label } : {}),
        }),
      ),
    ),
    fallback: Group({ children: props.fallback ?? null }),
  });
export const Elide = (
  props: Props & { unit: "characters" | "lines" | "items"; limit: number; marker?: string },
): PromptNode =>
  Object.freeze({
    ...base(props),
    kind: "elide",
    unit: props.unit,
    limit: props.limit,
    marker: props.marker ?? "…",
    children: children(props),
  });
export const Marker = (props: Props & { name: string; fields?: JsonObject }): PromptNode =>
  Object.freeze({
    ...base(props),
    kind: "marker",
    name: props.name,
    fields: freeze(copyJson(props.fields ?? {})),
    ...(Object.hasOwn(props, "children") ? { children: children(props) } : {}),
  });
export const tex = String.raw;

const toolNode = (
  style: ToolProjectionOptions["style"],
  props: Base & { snapshot: ToolSnapshot; qualify?: boolean; maxChars?: number },
): PromptNode =>
  Object.freeze({
    ...base(props),
    kind: "tools",
    toolSnapshot: freeze(copyJson(props.snapshot)),
    projection: Object.freeze({
      style,
      ...(props.qualify !== undefined ? { qualify: props.qualify } : {}),
      ...(props.maxChars !== undefined ? { maxChars: props.maxChars } : {}),
    }),
  });
export const ToolBrief = (
  props: Base & { snapshot: ToolSnapshot; qualify?: boolean; maxChars?: number },
): PromptNode => toolNode("brief", props);
export const CapabilityList = (
  props: Base & { snapshot: ToolSnapshot; qualify?: boolean },
): PromptNode => toolNode("capabilities", props);
export const ToolJson = (props: Base & { snapshot: ToolSnapshot }): PromptNode =>
  toolNode("json", props);
