import katex from "katex";
import { Marked } from "marked";
import { ownersIn, type TextPart } from "./model";

const markdown = new Marked({ gfm: true });
markdown.use({
  extensions: [
    {
      name: "displayMath",
      level: "block",
      start: (source) => source.indexOf("$$"),
      tokenizer(source) {
        const match = /^\$\$\n([\s\S]*?)\n\$\$(?:\n|$)/.exec(source);
        if (!match) return undefined;
        return { type: "displayMath", raw: match[0], tex: match[1] };
      },
      renderer(token) {
        return katex.renderToString(String(token.tex), {
          displayMode: true,
          throwOnError: false,
          trust: false,
        });
      },
    },
  ],
});

export interface PreviewUnit {
  id: string;
  kind: string;
  start: number;
  end: number;
  owners: string[];
  html: string;
}

/** Lex the complete text part first, including tables and cross-contribution equations.
 * Assets are explicit presentation boundaries in this spike. Mapping is block-level;
 * there is deliberately no claim of glyph/cell-level inverse layout mapping. */
export function previewUnits(part: TextPart): PreviewUnit[] {
  const tokens = markdown.lexer(part.text);
  const result: PreviewUnit[] = [];
  let offset = 0;
  for (const token of tokens) {
    const start = offset;
    offset += token.raw.length;
    const tokenList = Object.assign([token], { links: tokens.links });
    result.push({
      id: `${part.id}:${start}`,
      kind: token.type,
      start,
      end: offset,
      owners: ownersIn(part, start, offset),
      html: markdown.parser(tokenList),
    });
  }
  // The mock supports fixture text, not an arbitrary Markdown parser range contract.
  if (offset !== part.text.length) throw new Error(`Unmapped Markdown in fixture part ${part.id}`);
  return result;
}
