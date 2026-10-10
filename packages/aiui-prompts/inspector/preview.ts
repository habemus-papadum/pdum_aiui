import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { mathFromMarkdown } from "mdast-util-math";
import { gfm } from "micromark-extension-gfm";
import { math } from "micromark-extension-math";
import type { SemanticRegion } from "../src/model.ts";

/** Original compiled text coordinates, never offsets in decoded or rendered text. */
export interface OutputRange {
  part: string;
  start: number;
  end: number;
}

/** Owned positional contract. Parser-specific nodes never escape this adapter. */
export interface PreviewNode {
  type: string;
  range?: OutputRange;
  value?: string;
  depth?: number;
  ordered?: boolean;
  start?: number;
  checked?: boolean | null;
  url?: string;
  identifier?: string;
  alt?: string;
  children: PreviewNode[];
}

interface ParserNode {
  type: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  value?: string;
  depth?: number;
  ordered?: boolean;
  start?: number | null;
  checked?: boolean | null;
  url?: string;
  identifier?: string;
  alt?: string | null;
  children?: ParserNode[];
}

export interface PreviewDocument {
  part: string;
  nodes: PreviewNode[];
  definitions: ReadonlyMap<string, string>;
}

/**
 * Every range comes directly from the parser's original-source position. It is a
 * containing range, not a claim that DOM characters map one-to-one to Markdown.
 * The public UI advertises block or whole-equation navigation only.
 */
export function parsePreview(part: string, text: string): PreviewDocument {
  const tree = fromMarkdown(text, {
    extensions: [gfm(), math()],
    mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()],
  });
  const definitions = new Map<string, string>();
  function convert(node: ParserNode): PreviewNode {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (
      (start !== undefined || end !== undefined) &&
      (start === undefined || end === undefined || start < 0 || end < start || end > text.length)
    ) {
      throw new Error("Markdown parser returned an invalid original-source range");
    }
    if (node.type === "definition" && node.identifier && node.url) {
      definitions.set(node.identifier, node.url);
    }
    return {
      type: node.type,
      range: start === undefined || end === undefined ? undefined : { part, start, end },
      value: node.value,
      depth: node.depth,
      ordered: node.ordered,
      start: node.start ?? undefined,
      checked: node.checked,
      url: node.url,
      identifier: node.identifier,
      alt: node.alt ?? undefined,
      children: node.children?.map(convert) ?? [],
    };
  }
  const root = convert(tree as ParserNode);
  return { part, nodes: root.children, definitions };
}

/** XML encoding is a compiler transform; decode that one layer for math display only. */
export function mathPreviewValue(node: PreviewNode, regions: readonly SemanticRegion[]) {
  const range = node.range;
  const xmlEncoded =
    range !== undefined &&
    regions.some(
      (region) =>
        region.kind === "xml" &&
        region.part === range.part &&
        region.start <= range.start &&
        region.end >= range.end,
    );
  const value = node.value ?? "";
  if (!xmlEncoded) return { value, encoding: "literal" as const };
  const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">" };
  return {
    value: value.replace(/&(amp|lt|gt);/g, (_, entity: string) => entities[entity]),
    encoding: "xml-entities-once" as const,
  };
}

/** Explicitly reject executable URLs. Relative links are text in embedded inspectors. */
export function safeLink(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return ["http:", "https:", "mailto:"].includes(parsed.protocol) ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

/** The host supplies asset access. Do not fetch a ledger's file paths or arbitrary protocols. */
export function safeImageUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  if (/^data:image\/(?:png|jpeg|gif|webp|avif);base64,[a-z0-9+/=]+$/i.test(url)) return url;
  try {
    const parsed = new URL(url);
    return ["http:", "https:", "blob:"].includes(parsed.protocol) ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}
