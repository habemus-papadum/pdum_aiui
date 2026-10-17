/**
 * catalog.ts — the catalog page's text, parsed. The source of truth is
 * `packages/aiui-viz/CATALOG.md`, kept by hand; this module turns the subset
 * of Markdown it uses — headings, paragraphs, tables, lists, fenced code —
 * into a document the page renders, and classifies the tables: a table whose
 * first column is `Piece` or `Container` and which carries a `State` column
 * is a PIECE TABLE, each row an entry the page can hang a live specimen on.
 * Pure (playbook layer 1); the test runs it over the real file.
 *
 * Inline Markdown (code spans, links, emphasis) is left in the strings —
 * rendering it is the component's job (ui/Catalog.tsx, through `marked`).
 */

export type Block =
  | { kind: "paragraph"; text: string }
  | { kind: "heading"; level: number; text: string; id: string }
  | { kind: "table"; header: string[]; rows: string[][] }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "code"; lang: string; text: string };

export interface Section {
  /** The GitHub-style anchor of the heading (`1-the-substrate`). */
  id: string;
  title: string;
  blocks: Block[];
}

export interface CatalogDoc {
  title: string;
  /** Everything before the first `##`. */
  preamble: Block[];
  /** One per `##` heading; `###` headings are heading blocks inside. */
  sections: Section[];
}

export type PieceState = "shipped" | "spike" | "proposed";

/** One row of a piece table, by column role. */
export interface PieceRow {
  /** The specimen key: the first code span of the name, else its slug. */
  key: string;
  name: string;
  what: string;
  where: string;
  state: { primary: PieceState | undefined; label: string };
  seenIn: string;
}

// ── anchors and keys ─────────────────────────────────────────────────────────

/** GitHub's heading anchor: lowercase, punctuation dropped, spaces to hyphens. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
}

/** The key a specimen is attached by: the first code span, else the slug. */
export function pieceKey(name: string): string {
  const code = /`([^`]+)`/.exec(name);
  return code ? code[1].trim() : slugify(name);
}

/** The `State` cell: `shipped (the pill is …)` → primary `shipped`. */
export function parseState(cell: string): PieceRow["state"] {
  const label = cell.replace(/`/g, "").trim();
  const m = /\b(shipped|spike|proposed)\b/.exec(label);
  return { primary: m ? (m[1] as PieceState) : undefined, label };
}

// ── links ────────────────────────────────────────────────────────────────────

/**
 * Relative links in the file point at the repo; on a page they must point at
 * GitHub. `base` is the file's own URL there, so `../../demos/twins` resolves
 * the way it does in the repo. Absolute URLs and `#anchors` are untouched.
 */
export function rewriteLinks(md: string, base: string): string {
  return md.replace(/\]\(([^)\s]+)\)/g, (whole, target: string) => {
    if (/^(?:[a-z]+:|#)/i.test(target)) return whole;
    return `](${new URL(target, base).href})`;
  });
}

// ── tables ───────────────────────────────────────────────────────────────────

/** The cells of one `| a | b |` line, `\|` unescaped. */
export function tableCells(line: string): string[] {
  const inner = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return inner.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

const isSeparatorRow = (line: string): boolean => /^\|?\s*:?-{3,}/.test(line.trim());

export function isPieceTable(header: readonly string[]): boolean {
  return (header[0] === "Piece" || header[0] === "Container") && header.includes("State");
}

/** The rows of a piece table, by column role (header names, not positions). */
export function pieceRows(table: { header: string[]; rows: string[][] }): PieceRow[] {
  const col = (names: string[]): number => {
    for (const n of names) {
      const i = table.header.indexOf(n);
      if (i !== -1) return i;
    }
    return -1;
  };
  const iName = col(["Piece", "Container"]);
  const iWhat = col(["What it is", "What it holds"]);
  const iWhere = col(["Where"]);
  const iState = col(["State"]);
  const iSeen = col(["Seen in"]);
  const at = (row: string[], i: number): string => (i === -1 ? "" : (row[i] ?? ""));
  return table.rows.map((row) => ({
    key: pieceKey(at(row, iName)),
    name: at(row, iName),
    what: at(row, iWhat),
    where: at(row, iWhere),
    state: parseState(at(row, iState)),
    seenIn: at(row, iSeen),
  }));
}

// ── the document ─────────────────────────────────────────────────────────────

const FENCE = /^```(\S*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*$/;
const LIST_ITEM = /^([-*]|\d+\.)\s+(.*)$/;

export function parseCatalog(md: string): CatalogDoc {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const doc: CatalogDoc = { title: "", preamble: [], sections: [] };
  let into: Block[] = doc.preamble;
  let para: string[] = [];

  const flushPara = (): void => {
    if (para.length) {
      into.push({ kind: "paragraph", text: para.join(" ") });
      para = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const fence = FENCE.exec(line);
    if (fence) {
      flushPara();
      const body: string[] = [];
      for (i++; i < lines.length && !FENCE.test(lines[i]); i++) body.push(lines[i]);
      into.push({ kind: "code", lang: fence[1], text: body.join("\n") });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flushPara();
      const level = heading[1].length;
      const text = heading[2];
      if (level === 1) {
        doc.title = text;
      } else if (level === 2) {
        const section: Section = { id: slugify(text), title: text, blocks: [] };
        doc.sections.push(section);
        into = section.blocks;
      } else {
        into.push({ kind: "heading", level, text, id: slugify(text) });
      }
      continue;
    }

    if (line.trim().startsWith("|")) {
      flushPara();
      const header = tableCells(line);
      const rows: string[][] = [];
      for (i++; i < lines.length && lines[i].trim().startsWith("|"); i++) {
        if (!isSeparatorRow(lines[i])) rows.push(tableCells(lines[i]));
      }
      i--; // the loop's own increment steps past the table
      into.push({ kind: "table", header, rows });
      continue;
    }

    const item = LIST_ITEM.exec(line);
    if (item) {
      flushPara();
      const ordered = /\d/.test(item[1]);
      const items: string[] = [item[2]];
      for (i++; i < lines.length; i++) {
        const next = lines[i];
        if (next.trim() === "") break;
        const nextItem = LIST_ITEM.exec(next);
        if (nextItem) items.push(nextItem[2]);
        else if (/^\s+\S/.test(next)) items[items.length - 1] += ` ${next.trim()}`;
        else break;
      }
      i--;
      into.push({ kind: "list", ordered, items });
      continue;
    }

    if (line.trim() === "") {
      flushPara();
      continue;
    }
    para.push(line.trim());
  }
  flushPara();
  return doc;
}

/** Every piece row in the document, in order — the specimen keys' domain. */
export function allPieceRows(doc: CatalogDoc): PieceRow[] {
  const out: PieceRow[] = [];
  for (const blocks of [doc.preamble, ...doc.sections.map((s) => s.blocks)]) {
    for (const b of blocks) {
      if (b.kind === "table" && isPieceTable(b.header)) out.push(...pieceRows(b));
    }
  }
  return out;
}
