import { type Asset, frozen, type Node, type Selection, type Source } from "./model.ts";

export type Part = Readonly<{ type: "text"; text: string } | { type: "image"; asset: Asset }>;
export type Definition = Omit<Node, "children" | "short"> & {
  id: string;
  children: readonly string[];
  short?: readonly string[];
};
export type Occurrence = Readonly<{
  id: string;
  definition: string;
  parent?: string;
  headingLevel?: number;
  selected?: "full" | "short" | "omit";
}>;
export type OutputMap = Readonly<{
  occurrence: string;
  part: number;
  /** Half-open UTF-16 offsets in this part. Absent for atomic images. */
  start?: number;
  end?: number;
  relation: "authored" | "generated" | "escaped" | "asset";
}>;
export type CompiledPrompt = Readonly<{
  schema: "authoring-spike/1";
  definitions: readonly Definition[];
  occurrences: readonly Occurrence[];
  selection: Selection;
  parts: readonly Part[];
  outputMap: readonly OutputMap[];
  metrics: { textCodeUnits: number; images: number; tokenCount: null };
}>;
type Chunk = { occurrence: string } & (
  | { type: "text"; text: string; relation: "authored" | "generated" | "escaped" }
  | { type: "image"; asset: Asset }
);
const escapeXml = (text: string) => {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Validate the XML 1.0 character repertoire.
  if (/[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/u.test(text)) {
    throw new TypeError("XML text contains an invalid XML 1.0 character.");
  }
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
};

export function compilePrompt(root: Node, options: { selection?: Selection } = {}): CompiledPrompt {
  const definitions: Definition[] = [];
  const ids = new Map<Node, string>();
  const choiceNames = new Set<string>();
  function register(node: Node): string {
    const existing = ids.get(node);
    if (existing) return existing;
    const id = `d${ids.size + 1}`;
    ids.set(node, id);
    if (node.choice) {
      if (choiceNames.has(node.choice)) throw new Error(`Duplicate choice name: ${node.choice}`);
      choiceNames.add(node.choice);
    }
    const { children, short, ...properties } = node;
    definitions.push({
      id,
      ...properties,
      children: children.map(register),
      ...(short ? { short: short.map(register) } : {}),
    });
    return id;
  }
  register(root);
  const selection = { ...options.selection };
  for (const [name, mode] of Object.entries(selection)) {
    if (!choiceNames.has(name)) throw new Error(`Unknown choice name: ${name}`);
    if (!["full", "short", "omit"].includes(mode)) throw new Error(`Invalid choice mode: ${mode}`);
  }
  const occurrences: Occurrence[] = [];
  function render(node: Node, path: string, depth: number, parent?: string, xml = false): Chunk[] {
    if (xml && !["text", "group", "join", "choice", "xml"].includes(node.kind)) {
      throw new Error(`${node.kind} is not supported inside XML in this spike.`);
    }
    const selected = node.kind === "choice" ? (selection[node.choice ?? ""] ?? "full") : undefined;
    const occurrence: Occurrence = {
      id: path,
      definition: ids.get(node) as string,
      ...(parent ? { parent } : {}),
      ...(node.kind === "section" ? { headingLevel: depth + 1 } : {}),
      ...(selected ? { selected } : {}),
    };
    occurrences.push(occurrence);
    const text = (value: string, relation: "authored" | "generated" = "generated"): Chunk[] => {
      const encoded = xml && relation === "authored" ? escapeXml(value) : value;
      return encoded
        ? [
            {
              type: "text",
              text: encoded,
              occurrence: path,
              relation: encoded === value ? relation : "escaped",
            },
          ]
        : [];
    };
    function sequence(
      nodes: readonly Node[],
      separator = "",
      branch = "children",
      nextDepth = depth,
      inXml = xml,
    ): Chunk[] {
      const rendered = nodes
        .map((child, i) => render(child, `${path}/${branch}/${i}`, nextDepth, path, inXml))
        .filter((x) => x.length);
      return rendered.flatMap((chunks, i) =>
        i === 0 ? chunks : [...text(separator, xml ? "authored" : "generated"), ...chunks],
      );
    }
    switch (node.kind) {
      case "text":
        return text(node.value ?? "", "authored");
      case "image":
        return [{ type: "image", asset: node.asset as Asset, occurrence: path }];
      case "math":
        return [
          ...text(node.display ? "$$\n" : "$"),
          ...text(node.value ?? "", "authored"),
          ...text(node.display ? "\n$$" : "$"),
        ];
      case "prompt":
        return sequence(node.children, "\n\n");
      case "section": {
        if (depth >= 6)
          throw new Error("Markdown heading depth exceeds six; this spike rejects overflow.");
        if (/[\r\n]/.test(node.title ?? "")) throw new Error("Section title must occupy one line.");
        const body = sequence(node.children, "\n\n", "children", depth + 1);
        // Empty sections disappear only after selection; their occurrence remains inspectable.
        return body.length
          ? [
              ...text(`${"#".repeat(depth + 1)} `),
              ...text(node.title ?? "", "authored"),
              ...text("\n\n"),
              ...body,
            ]
          : [];
      }
      case "paragraph":
      case "group":
        return sequence(node.children);
      case "join":
        return sequence(node.children, node.separator);
      case "choice":
        return selected === "omit"
          ? []
          : sequence(selected === "short" ? (node.short ?? []) : node.children, "", selected);
      case "xml": {
        const attributes = Object.entries(node.attributes ?? {})
          .map(
            ([name, value]) =>
              ` ${name}="${escapeXml(value).replaceAll('"', "&quot;").replaceAll("\t", "&#9;").replaceAll("\n", "&#10;").replaceAll("\r", "&#13;")}"`,
          )
          .join("");
        return [
          ...text(`<${node.tag}${attributes}>`),
          ...sequence(node.children, "", "children", depth, true),
          ...text(`</${node.tag}>`),
        ];
      }
    }
  }
  const parts: Part[] = [];
  const outputMap: OutputMap[] = [];
  for (const chunk of render(root, "root", 0)) {
    if (chunk.type === "image") {
      outputMap.push({ occurrence: chunk.occurrence, part: parts.length, relation: "asset" });
      parts.push({ type: "image", asset: chunk.asset });
    } else {
      const last = parts.at(-1);
      const start = last?.type === "text" ? last.text.length : 0;
      if (last?.type === "text")
        parts[parts.length - 1] = { type: "text", text: last.text + chunk.text };
      else parts.push({ type: "text", text: chunk.text });
      outputMap.push({
        occurrence: chunk.occurrence,
        part: parts.length - 1,
        start,
        end: start + chunk.text.length,
        relation: chunk.relation,
      });
    }
  }
  return frozen({
    schema: "authoring-spike/1",
    definitions,
    occurrences,
    selection,
    parts,
    outputMap,
    metrics: {
      textCodeUnits: parts.reduce(
        (sum, part) => sum + (part.type === "text" ? part.text.length : 0),
        0,
      ),
      images: parts.filter((part) => part.type === "image").length,
      tokenCount: null,
    },
  });
}

/** Exact output slices belong to an occurrence; source labels are only coarse ownership. */
export function explainRange(artifact: CompiledPrompt, part: number, start?: number, end?: number) {
  return artifact.outputMap
    .filter(
      (map) =>
        map.part === part &&
        (map.start === undefined ||
          start === undefined ||
          end === undefined ||
          (map.start < end && (map.end ?? 0) > start)),
    )
    .map((map) => {
      const occurrence = artifact.occurrences.find((item) => item.id === map.occurrence);
      const definition = artifact.definitions.find((item) => item.id === occurrence?.definition);
      return {
        ...map,
        source: definition?.source as Source | undefined,
        sourcePrecision: definition?.source ? ("owner-only" as const) : ("unavailable" as const),
      };
    });
}
