#!/usr/bin/env node
// docs-lint — a fast guard for the ONE docs-build failure that keeps tripping CI:
// bare angle-bracket placeholders in prose (`<path>`, `<port>`, `<user-data-dir>`)
// that an author forgot to wrap in backticks.
//
// Why this exists: VitePress compiles every markdown page through Vue's template
// compiler, so a bare `<path>` reads as an HTML element with no closing tag and the
// build dies with "Element is missing end tag" (or "Invalid end tag" for a stray
// `</foo>`). Biome doesn't lint markdown, so the only gate today is the full
// `vitepress build` on push-to-main — a ~1-minute job that reports a useless
// position in its *transformed* SFC (e.g. "aiui-registry.md (113:73)"), nowhere near
// the real source line. This script reproduces exactly those two failure modes in
// well under a second, with a precise file:line:col pointing at the offending tag.
//
// It is deliberately a tag-balance check on prose only: fenced code, inline code,
// HTML comments, and `<scheme://…>` / `<a@b>` autolinks are stripped first (VitePress
// escapes those, so they never reach Vue as tags). What's left is scanned for HTML
// tags; an open tag with no close, or a close with no open, is what Vue would reject.
//
// Run: `pnpm docs:lint`  (also wired into CI next to Biome, and the pre-commit hook).
// Scope: every human-authored markdown page VitePress compiles — hand-written pages
// under docs/, plus the package READMEs and per-package guides that docs-gen copies
// in. The generated docs/packages/** and TypeDoc API pages are machine-produced and
// excluded (they're gitignored and regenerated on every build).

import { globSync, readFileSync } from "node:fs";
import { relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

// HTML void elements never need a closing tag — Vue treats them as self-contained.
// Everything NOT in this set (including SVG-ish names like `path`, or placeholders
// like `port`) is a normal element Vue expects to be closed. That mismatch is the bug.
const VOID = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

/** Strip spans VitePress escapes before Vue ever sees them, preserving line count so
 *  reported line numbers stay true. Replaces stripped regions with spaces/newlines. */
function stripCode(src) {
  const lines = src.split("\n");
  const out = [];
  let fence = null; // the fence marker (``` or ~~~ run) we're inside, or null
  for (const line of lines) {
    const fenceOpen = line.match(/^(\s*)(`{3,}|~{3,})/);
    if (fence) {
      out.push(""); // blank out fenced body
      if (fenceOpen && fenceOpen[2][0] === fence[0] && fenceOpen[2].length >= fence.length) {
        fence = null; // closing fence
      }
      continue;
    }
    if (fenceOpen) {
      fence = fenceOpen[2];
      out.push(""); // blank out the opening fence line
      continue;
    }
    out.push(line);
  }
  let text = out.join("\n");

  // Blank out HTML comments (may span lines) — keep newlines so positions hold.
  text = text.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "));

  // Blank out inline code spans (single or multi backtick), per line.
  text = text.replace(/(`+)(?:(?!\1).)*\1/g, (m) => " ".repeat(m.length));

  // Blank out markdown autolinks: <scheme://…>, <mailto:…>, <user@host>. VitePress
  // turns these into <a> tags, so they're not raw tags Vue would choke on.
  text = text.replace(/<[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^>\s]*>/g, (m) => " ".repeat(m.length));
  text = text.replace(/<[^<>\s@]+@[^<>\s]+>/g, (m) => " ".repeat(m.length));

  // Drop backslash-escaped angle brackets — markdown renders them as literal text.
  text = text.replace(/\\[<>]/g, "  ");

  return text;
}

/** Yield {name, close, selfClose, line, col} for every HTML-ish tag in stripped prose. */
function* tags(text) {
  const re = /<(\/)?([a-zA-Z][a-zA-Z0-9-]*)([^<>]*?)(\/)?>/g;
  for (const m of text.matchAll(re)) {
    const before = text.slice(0, m.index);
    const line = before.split("\n").length;
    const col = m.index - before.lastIndexOf("\n");
    yield {
      name: m[2].toLowerCase(),
      close: Boolean(m[1]),
      selfClose: Boolean(m[4]),
      line,
      col,
    };
  }
}

/** Return the list of {line, col, msg} problems for one file's source. */
function lintSource(src) {
  const text = stripCode(src);
  const stack = [];
  const problems = [];
  for (const t of tags(text)) {
    if (t.close) {
      // Find the nearest matching open tag on the stack.
      let i = stack.length - 1;
      while (i >= 0 && stack[i].name !== t.name) i--;
      if (i < 0) {
        problems.push({
          line: t.line,
          col: t.col,
          msg: `stray </${t.name}> with no matching <${t.name}> (Vue: "Invalid end tag")`,
        });
      } else {
        stack.length = i; // pop it (and anything implicitly closed above it)
      }
    } else if (!t.selfClose && !VOID.has(t.name)) {
      stack.push(t);
    }
  }
  for (const open of stack) {
    problems.push({
      line: open.line,
      col: open.col,
      msg: `<${open.name}> is never closed (Vue: "Element is missing end tag") — wrap the placeholder in \`backticks\` if it's literal text`,
    });
  }
  return problems.sort((a, b) => a.line - b.line || a.col - b.col);
}

// Every human-authored markdown page that becomes a VitePress page. globSync excludes
// the generated docs/packages/** (TypeDoc + copied guides) — those are machine-made.
const patterns = ["docs/**/*.md", "packages/*/README.md", "packages/*/docs/**/*.md"];
const files = [
  ...new Set(patterns.flatMap((p) => globSync(p, { cwd: ROOT }).map((f) => `${ROOT}${f}`))),
].filter((f) => !f.includes("/docs/packages/"));

let bad = 0;
for (const file of files.sort()) {
  const problems = lintSource(readFileSync(file, "utf8"));
  for (const p of problems) {
    bad++;
    console.error(`${relative(ROOT, file)}:${p.line}:${p.col}  ${p.msg}`);
  }
}

if (bad) {
  console.error(
    `\n✖ docs-lint: ${bad} unbalanced tag(s) in prose. VitePress compiles markdown\n` +
      `  through Vue, so these break \`pnpm docs:build\`. Wrap literal placeholders like\n` +
      `  \`<path>\` in backticks, or close/self-close real HTML tags.`,
  );
  process.exit(1);
}
console.log(`✓ docs-lint: ${files.length} markdown pages, no unbalanced tags in prose`);
