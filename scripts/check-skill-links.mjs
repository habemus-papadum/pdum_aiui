#!/usr/bin/env node
// Link health for the repo-root Claude plugin (.claude-plugin/ + skills/).
// Zero dependencies — run with the repo's own Node.
//
// The plugin ships as the WHOLE repo (installed from the git marketplace, or
// loaded with --plugin-dir at the repo root in a source checkout), so skill
// markdown links straight into docs/guide/, packages/*/docs/, etc. with
// ordinary relative links — no bundling, no rewriting, nothing generated.
// The one thing that can rot is a link whose target moves: this check walks
// every .md under skills/, resolves every relative link, and fails on any
// that resolves nowhere. It also parses the two plugin manifests, so a
// syntax error never waits for an install to surface.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Every .md file under a directory, recursively. */
function markdownFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...markdownFiles(path));
    } else if (entry.name.endsWith(".md")) {
      found.push(path);
    }
  }
  return found;
}

/**
 * Markdown inline links: `[text](target)`, capturing the target. Deliberately
 * simple — the skills' own markdown is ours to keep parseable (no angle
 * brackets, no titles, no reference-style links pointing at files).
 */
const LINK_RE = /\]\(([^)\s]+)\)/g;

/** A link this check owns: relative, into the filesystem, not an anchor. */
function isRelativeFileLink(target) {
  return (
    !/^[a-z][a-z0-9+.-]*:/i.test(target) && // http:, https:, mailto:, vscode:, …
    !target.startsWith("/") &&
    !target.startsWith("#")
  );
}

const problems = [];

for (const manifest of [".claude-plugin/plugin.json", ".claude-plugin/marketplace.json"]) {
  try {
    JSON.parse(readFileSync(join(repoRoot, manifest), "utf8"));
  } catch (error) {
    problems.push(`${manifest}: ${error.message}`);
  }
}

for (const mdPath of markdownFiles(join(repoRoot, "skills"))) {
  const rel = relative(repoRoot, mdPath);
  for (const match of readFileSync(mdPath, "utf8").matchAll(LINK_RE)) {
    const target = match[1];
    if (!isRelativeFileLink(target)) {
      continue;
    }
    const pathPart = target.split(/[#?]/)[0];
    if (pathPart !== "" && !existsSync(resolve(dirname(mdPath), pathPart))) {
      problems.push(`${rel}: relative link does not resolve: ${target}`);
    }
  }
}

if (problems.length > 0) {
  console.error("the repo-root plugin is unhealthy:");
  for (const problem of problems) {
    console.error(`  ${problem}`);
  }
  process.exit(1);
}
console.log("plugin manifests parse; skill markdown links all resolve");
