import { copyJson, sha256 } from "./json.ts";
import { Group, type Origin, PromptError, type PromptNode, Text } from "./model.ts";

export interface ImportedTextSpan {
  readonly start: number;
  readonly end: number;
  readonly origin: Origin;
  readonly label?: string;
}

/** Retain an existing renderer's exact text and disjoint owner spans without importing its logic. */
export function importText(input: {
  readonly text: string;
  readonly origin: Origin;
  readonly spans?: readonly ImportedTextSpan[];
  readonly label?: string;
}): PromptNode {
  const value = copyJson(input);
  if (
    typeof value.text !== "string" ||
    !value.origin ||
    typeof value.origin !== "object" ||
    Array.isArray(value.origin)
  )
    throw new PromptError(
      "IMPORTED_TEXT",
      "Imported text requires an exact string and a captured origin.",
    );
  if (value.spans !== undefined && !Array.isArray(value.spans))
    throw new PromptError("IMPORTED_TEXT", "Imported spans must be an array.");
  const spans = [...(value.spans ?? [])];
  const splitSurrogate = (position: number) =>
    position > 0 &&
    position < value.text.length &&
    /[\uD800-\uDBFF]/.test(value.text[position - 1]) &&
    /[\uDC00-\uDFFF]/.test(value.text[position]);
  for (const span of spans) {
    if (
      !span ||
      !Number.isSafeInteger(span.start) ||
      !Number.isSafeInteger(span.end) ||
      span.start < 0 ||
      span.end <= span.start ||
      span.end > value.text.length ||
      splitSurrogate(span.start) ||
      splitSurrogate(span.end) ||
      !span.origin ||
      typeof span.origin !== "object" ||
      Array.isArray(span.origin) ||
      (span.label !== undefined && typeof span.label !== "string")
    )
      throw new PromptError("IMPORTED_TEXT", "Invalid nonempty UTF-16 imported span or origin.");
  }
  spans.sort((a, b) => a.start - b.start);
  let cursor = 0;
  const children: PromptNode[] = [];
  const revision = `sha256:${sha256(value.text)}`;
  const piece = (start: number, end: number, origin: Origin, label?: string) =>
    Text({
      value: value.text.slice(start, end),
      ...(label !== undefined ? { label } : {}),
      origin: {
        kind: "imported-text",
        precision: "owner",
        revision,
        span: { start, end },
        input: origin,
      },
    });
  for (const span of spans) {
    if (span.start < cursor)
      throw new PromptError("IMPORTED_TEXT", "Imported primary owner spans must not overlap.");
    if (span.start > cursor) children.push(piece(cursor, span.start, value.origin));
    children.push(piece(span.start, span.end, span.origin, span.label));
    cursor = span.end;
  }
  if (cursor < value.text.length || !children.length)
    children.push(piece(cursor, value.text.length, value.origin));
  return Group({
    children,
    origin: value.origin,
    ...(value.label !== undefined ? { label: value.label } : {}),
  });
}
