/** Executable syntax experiment. These are not the production package's contracts. */
export type Child = Node | string | number | false | null | readonly Child[];
export type Source = Readonly<{ label: string; file?: string; origin?: string }>;
export type Asset = Readonly<{
  id: string;
  mimeType: string;
  uri: string;
  alt: string;
  revision?: string;
  width?: number;
  height?: number;
}>;
export type Selection = Readonly<Record<string, "full" | "short" | "omit">>;
export type Kind =
  | "prompt"
  | "group"
  | "section"
  | "paragraph"
  | "text"
  | "math"
  | "image"
  | "xml"
  | "choice"
  | "join";
export type Node = Readonly<{
  kind: Kind;
  children: readonly Node[];
  source?: Source;
  label?: string;
  value?: string;
  title?: string;
  display?: boolean;
  asset?: Asset;
  tag?: string;
  attributes?: Readonly<Record<string, string>>;
  separator?: string;
  choice?: string;
  short?: readonly Node[];
}>;
type Base = { children?: Child; source?: Source; label?: string };

export function frozen<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}

function children(value: Child | undefined, omitted = false): readonly Node[] {
  if (value === undefined) {
    if (omitted) return [];
    throw new TypeError("Undefined prompt child: handle missing data explicitly with null.");
  }
  if (value === null || value === false) return [];
  if (Array.isArray(value)) return value.flatMap((item) => children(item));
  if (typeof value === "string") return [make("text", {}, { value })];
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Format non-finite numbers explicitly.");
    return [make("text", {}, { value: String(value) })];
  }
  if (typeof value === "object" && "kind" in value && "children" in value) return [value as Node];
  throw new TypeError(
    "Prompt children must be prepared values; promises and arbitrary objects are not supported.",
  );
}

function make(kind: Kind, props: Base, extra: Partial<Node> = {}): Node {
  // Copy user-supplied metadata; creating a prompt does not freeze application objects.
  return frozen({
    kind,
    children: children(props.children, !("children" in props)),
    ...(props.label ? { label: props.label } : {}),
    ...(props.source ? { source: { ...props.source } } : {}),
    ...extra,
  });
}
export const Prompt = (props: Base): Node => make("prompt", props);
export const Group = (props: Base): Node => make("group", props);
export const Paragraph = (props: Base): Node => make("paragraph", props);
export const Section = (props: Base & { title: string }): Node =>
  make("section", props, { title: props.title });
/** Exact string leaf. TSX prose instead follows the normal JSX whitespace transform. */
export const Text = (props: Omit<Base, "children"> & { value: string }): Node =>
  make("text", props, { value: props.value });
// biome-ignore lint/suspicious/noShadowRestrictedNames: Math is a prompt JSX component, not the numeric global.
export const Math = (props: Omit<Base, "children"> & { value: string; display?: boolean }): Node =>
  make("math", props, { value: props.value, display: props.display ?? true });
export const Image = (props: Omit<Base, "children"> & { asset: Asset }): Node =>
  make("image", props, { asset: { ...props.asset } });
export const Join = (props: Base & { separator: string }): Node =>
  make("join", props, { separator: props.separator });
export const Choice = (props: Base & { name: string; short: Child }): Node =>
  make("choice", props, { choice: props.name, short: children(props.short) });
export const Xml = (
  props: Base & { tag: string; attributes?: Readonly<Record<string, string>> },
): Node => {
  // Deliberately a small namespace-free XML subset, not a general XML parser.
  const name = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
  if (!name.test(props.tag)) throw new TypeError(`Invalid XML tag: ${props.tag}`);
  for (const key of Object.keys(props.attributes ?? {})) {
    if (!name.test(key)) throw new TypeError(`Invalid XML attribute: ${key}`);
  }
  return make("xml", props, { tag: props.tag, attributes: { ...props.attributes } });
};
/** Preserve backslashes; interpolation still uses explicit TypeScript value formatting. */
export const tex = String.raw;
