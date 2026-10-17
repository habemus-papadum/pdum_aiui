/**
 * source-tree.ts — the pure half of the dock's source browser: the file
 * list as a tree, a file's extension as a highlight.js language, the lazy
 * highlighter (core + the grammars an aiui app's files need, loaded the
 * first time the pane opens — nothing on a page that never looks), and the
 * line splitter that keeps highlighted HTML balanced per line so every line
 * can carry its own number.
 */
import type { HLJSApi } from "highlight.js";

export interface SourceTreeNode {
  name: string;
  /** The stamp path (a file); absent on a directory. */
  path?: string;
  children?: SourceTreeNode[];
}

/**
 * The listing as a tree: directories first, then files, both by name. A
 * stamp path that climbs (`../seismos/src/x.ts`) hangs under a `..` node —
 * honest about where the file sits relative to the app root.
 */
export function buildSourceTree(files: readonly string[]): SourceTreeNode[] {
  const root: SourceTreeNode = { name: "", children: [] };
  for (const path of files) {
    const parts = path.split("/").filter((p) => p !== "");
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i] ?? "";
      const leaf = i === parts.length - 1;
      node.children ??= [];
      let next = node.children.find((c) => c.name === name && (c.children !== undefined) !== leaf);
      if (next === undefined) {
        next = leaf ? { name, path } : { name, children: [] };
        node.children.push(next);
      }
      node = next;
    }
  }
  const sort = (nodes: SourceTreeNode[]): SourceTreeNode[] => {
    for (const n of nodes) if (n.children !== undefined) sort(n.children);
    return nodes.sort((a, b) => {
      const ad = a.children !== undefined ? 0 : 1;
      const bd = b.children !== undefined ? 0 : 1;
      return ad - bd || a.name.localeCompare(b.name);
    });
  };
  return sort(root.children ?? []);
}

/** The highlight.js language for a file, by extension; undefined = plain text. */
export function languageFor(file: string): string | undefined {
  const ext = file.slice(file.lastIndexOf(".") + 1).toLowerCase();
  switch (ext) {
    case "ts":
    case "tsx":
    case "mts":
    case "cts":
      return "typescript";
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return "javascript";
    case "css":
      return "css";
    case "json":
      return "json";
    case "md":
      return "markdown";
    case "html":
    case "svg":
    case "xml":
      return "xml";
    default:
      return undefined;
  }
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Highlighted HTML, one entry per source line, each balanced: a span that
 * highlight.js opened on one line and closed on a later one (a block
 * comment, a template literal) is closed at the line's end and reopened on
 * the next, so every line renders alone.
 */
export function splitHighlighted(html: string): string[] {
  const out: string[] = [];
  let open: string[] = [];
  for (const line of html.split("\n")) {
    const prefix = open.join("");
    const stack = [...open];
    for (const m of line.matchAll(/<span[^>]*>|<\/span>/g)) {
      if (m[0] === "</span>") stack.pop();
      else stack.push(m[0]);
    }
    out.push(`${prefix}${line}${"</span>".repeat(stack.length)}`);
    open = stack;
  }
  return out;
}

let held: Promise<HLJSApi> | undefined;

/** highlight.js core with the grammars registered, loaded once on first use. */
export function loadHighlighter(): Promise<HLJSApi> {
  held ??= Promise.all([
    import("highlight.js/lib/core"),
    import("highlight.js/lib/languages/typescript"),
    import("highlight.js/lib/languages/javascript"),
    import("highlight.js/lib/languages/css"),
    import("highlight.js/lib/languages/json"),
    import("highlight.js/lib/languages/markdown"),
    import("highlight.js/lib/languages/xml"),
  ]).then(([core, ts, js, css, json, md, xml]) => {
    const hljs = core.default;
    hljs.registerLanguage("typescript", ts.default);
    hljs.registerLanguage("javascript", js.default);
    hljs.registerLanguage("css", css.default);
    hljs.registerLanguage("json", json.default);
    hljs.registerLanguage("markdown", md.default);
    hljs.registerLanguage("xml", xml.default);
    return hljs;
  });
  held.catch(() => {
    held = undefined; // let a later open retry the load
  });
  return held;
}

/** A file's text as per-line HTML: highlighted when the language is known, escaped otherwise. */
export function highlightLines(text: string, file: string, hljs: HLJSApi | undefined): string[] {
  const language = languageFor(file);
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  if (hljs !== undefined && language !== undefined && hljs.getLanguage(language) !== undefined) {
    return splitHighlighted(hljs.highlight(body, { language, ignoreIllegals: true }).value);
  }
  return body.split("\n").map(escapeHtml);
}
