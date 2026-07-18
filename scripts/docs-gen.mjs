#!/usr/bin/env node
// Generate the VitePress documentation tree from the monorepo.
//
// Usage: pnpm docs:gen   (run automatically by docs:dev / docs:build)
//
// This is the "MkDocs for a pnpm monorepo" glue. It discovers packages by the same
// `packages/*` glob the rest of the repo uses, so a NEW PACKAGE NEEDS ZERO CONFIG EDITS:
// its README becomes an overview page and its exported API is extracted into a reference
// section automatically. Top-level conceptual docs under `docs/` are auto-listed too.
//
// What it produces (everything under docs/packages/** and the generated sidebar is derived
// and gitignored — never edit by hand):
//
//   docs/packages/index.md              overview grid of every package
//   docs/packages/<slug>/index.md       copied from packages/<slug>/README.md
//   docs/packages/<slug>/<guide>.md     copied from packages/<slug>/docs/*.md (if any)
//   docs/packages/<slug>/api/**         TypeDoc-generated Markdown API reference
//   docs/.vitepress/sidebar.generated.json   the sidebar config config.ts imports

import { execFileSync } from "node:child_process";
import {
  existsSync,
  globSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, "..");
const packagesDir = join(repoRoot, "packages");
const docsDir = join(repoRoot, "docs");
const genPackagesDir = join(docsDir, "packages");
const sidebarFile = join(docsDir, ".vitepress", "sidebar.generated.json");

/** Resolve the locally-installed TypeDoc CLI entry point. */
function typedocBin() {
  const pkgJson = require.resolve("typedoc/package.json");
  const bin = JSON.parse(readFileSync(pkgJson, "utf8")).bin;
  const rel = typeof bin === "string" ? bin : bin.typedoc;
  return join(dirname(pkgJson), rel);
}

/** First `# ` heading in some Markdown, else a fallback. */
function titleOf(markdown, fallback) {
  const match = markdown.match(/^#\s+(.+?)\s*$/m);
  return match ? match[1].replace(/^`|`$/g, "") : fallback;
}

/** Discover every workspace package by the same glob convention the repo uses elsewhere. */
function discoverPackages() {
  return globSync("*/package.json", { cwd: packagesDir })
    .map((rel) => {
      const slug = dirname(rel);
      const dir = join(packagesDir, slug);
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      return {
        slug,
        dir,
        name: pkg.name ?? slug,
        description: pkg.description ?? "",
        noPublish: pkg.private === true,
        indexTs: join(dir, "src", "index.ts"),
        // Every source entry the dev `exports` map exposes ("." plus subpaths
        // like "./plot", "./site", "./vite") — so the API reference covers the
        // whole public surface, not just the root barrel.
        entryPoints: Object.values(pkg.exports ?? {})
          .filter((v) => typeof v === "string" && v.startsWith("./src/"))
          .map((v) => join(dir, v)),
        readme: join(dir, "README.md"),
        docsDir: join(dir, "docs"),
      };
    })
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

/** Copy the package README in as the overview page (or synthesize a minimal one). */
function writeOverview(pkg, outDir) {
  const body = existsSync(pkg.readme)
    ? readFileSync(pkg.readme, "utf8")
    : `# ${pkg.name}\n\n${pkg.description || "_No description._"}\n`;
  writeFileSync(join(outDir, "index.md"), body);
}

/** Copy hand-authored per-package guides from packages/<slug>/docs/*.md, if present. */
function copyPackageGuides(pkg, outDir) {
  if (!existsSync(pkg.docsDir)) return [];
  const guides = [];
  for (const file of readdirSync(pkg.docsDir)) {
    if (!file.endsWith(".md") || file.toLowerCase() === "index.md") continue;
    const src = join(pkg.docsDir, file);
    const body = readFileSync(src, "utf8");
    writeFileSync(join(outDir, file), body);
    guides.push({
      text: titleOf(body, basename(file, ".md")),
      link: `/packages/${pkg.slug}/${basename(file, ".md")}`,
    });
  }
  return guides;
}

/** Run TypeDoc → Markdown for one package. Returns the API sidebar items, or null. */
function generateApi(pkg, outDir) {
  const entries = (pkg.entryPoints?.length ? pkg.entryPoints : [pkg.indexTs]).filter((e) =>
    existsSync(e),
  );
  if (entries.length === 0) return null;
  const apiDir = join(outDir, "api");
  const args = [
    typedocBin(),
    "--plugin",
    "typedoc-plugin-markdown",
    "--plugin",
    "typedoc-vitepress-theme",
    ...entries.flatMap((e) => ["--entryPoints", e]),
    "--tsconfig",
    join(pkg.dir, "tsconfig.json"),
    "--out",
    apiDir,
    "--docsRoot", // makes the vitepress theme root sidebar links at "/" (strips the docs/ srcDir)
    docsDir,
    "--readme",
    "none",
    "--githubPages",
    "false",
    "--hideBreadcrumbs",
    "true",
    "--excludeInternal",
    "true",
    "--skipErrorChecking", // a type error in one package shouldn't sink the docs build
    "--gitRevision",
    "main",
  ];
  try {
    execFileSync("node", args, { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    process.stderr.write(
      `  ! TypeDoc failed for ${pkg.slug}; skipping API section\n${err.stderr ?? err.message}\n`,
    );
    return null;
  }
  // typedoc-vitepress-theme drops a ready-made sidebar array here.
  const sidebarJson = join(apiDir, "typedoc-sidebar.json");
  if (!existsSync(sidebarJson)) return null;
  const items = JSON.parse(readFileSync(sidebarJson, "utf8"));
  return items.length ? items : null;
}

/** Write docs/packages/index.md — an overview grid of every package. */
function writePackagesIndex(pkgs) {
  const lines = [
    "# Packages",
    "",
    `The \`@habemus-papadum\` monorepo ships ${pkgs.length} package${pkgs.length === 1 ? "" : "s"}, versioned in lockstep.`,
    "",
    "| Package | Description |",
    "| ------- | ----------- |",
  ];
  for (const pkg of pkgs) {
    const tag = pkg.noPublish ? " _(internal)_" : "";
    lines.push(`| [\`${pkg.name}\`](/packages/${pkg.slug}/) | ${pkg.description}${tag} |`);
  }
  lines.push("");
  writeFileSync(join(genPackagesDir, "index.md"), `${lines.join("\n")}\n`);
}

function main() {
  // Start from a clean generated tree so deleted packages/pages don't linger.
  rmSync(genPackagesDir, { recursive: true, force: true });
  mkdirSync(genPackagesDir, { recursive: true });

  const pkgs = discoverPackages();
  const packageNodes = [];

  for (const pkg of pkgs) {
    const outDir = join(genPackagesDir, pkg.slug);
    mkdirSync(outDir, { recursive: true });
    writeOverview(pkg, outDir);
    const guides = copyPackageGuides(pkg, outDir);
    const api = generateApi(pkg, outDir);

    const items = [{ text: "Overview", link: `/packages/${pkg.slug}/` }, ...guides];
    if (api) items.push({ text: "API Reference", collapsed: true, items: api });

    packageNodes.push({ text: pkg.slug, collapsed: true, items });
    process.stdout.write(
      `  ✓ ${pkg.slug} — overview${guides.length ? ` + ${guides.length} guide(s)` : ""}${api ? " + API" : ""}\n`,
    );
  }

  writePackagesIndex(pkgs);

  const sidebar = {
    "/": [
      {
        text: "User Guide",
        items: [
          { text: "Introduction", link: "/guide/" },
          { text: "Getting Started", link: "/guide/getting-started" },
          { text: "Installation", link: "/guide/installation" },
          { text: "Prompt Linting", link: "/guide/prompt-linting" },
          { text: "VS Code Integration", link: "/guide/vscode" },
          { text: "The Browser Extension", link: "/guide/browser-extension" },
          { text: "Configuration", link: "/guide/config" },
          { text: "⚠️ Read Before Running", link: "/guide/warning" },
        ],
      },
      {
        text: "Concepts & Design",
        items: [
          { text: "Motivation & Workflow", link: "/guide/motivation" },
          { text: "Prompt Lowering", link: "/guide/prompt-lowering" },
          { text: "Prompt Rendering Reference", link: "/guide/prompt-rendering" },
          { text: "The Channel MCP Server", link: "/guide/channel" },
          { text: "The Transcription Layer", link: "/guide/transcription" },
          { text: "Realtime Live Mode", link: "/guide/realtime-live" },
          { text: "Realtime: the Wire", link: "/guide/realtime-vendors" },
          { text: "The Agent's Browser", link: "/guide/chrome" },
          { text: "Remote Development", link: "/guide/remote" },
          { text: "Attribution: Gesture → Source", link: "/guide/attribution" },
          {
            text: "Frontend for Agents",
            collapsed: false,
            items: [
              { text: "User Guide", link: "/guide/frontend-user-guide" },
              { text: "Playbook", link: "/guide/frontend-playbook" },
              { text: "Concepts", link: "/guide/frontend-for-agents" },
              { text: "Design Choices", link: "/guide/frontend-design-choices" },
              { text: "Hard-Won Details", link: "/guide/frontend-hard-won" },
              { text: "Style Guide", link: "/guide/frontend-style-guide" },
            ],
          },
        ],
      },
      {
        text: "Developers",
        collapsed: true,
        items: [
          { text: "Developing pdum_aiui", link: "/guide/development" },
          { text: "Documentation System", link: "/guide/documentation" },
          { text: "Releasing & Publishing", link: "/guide/releasing" },
        ],
      },
      { text: "Packages", link: "/packages/", items: packageNodes },
    ],
  };

  // The guide sidebar above is CURATED (sections, order, titles are editorial)
  // — but curation drifts silently. Guard it both ways: every /guide/ link
  // must have a page, and every page must have a link, or generation fails.
  const linkedGuides = new Set();
  const collectGuideLinks = (nodes) => {
    for (const node of nodes) {
      const m = /^\/guide\/([^/]*)$/.exec(node.link ?? "");
      if (m) {
        linkedGuides.add(m[1] === "" ? "index" : m[1]);
      }
      if (node.items) {
        collectGuideLinks(node.items);
      }
    }
  };
  collectGuideLinks(sidebar["/"]);
  const guidePages = new Set(
    readdirSync(join(docsDir, "guide"))
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.replace(/\.md$/, "")),
  );
  const deadLinks = [...linkedGuides].filter((g) => !guidePages.has(g));
  const unlisted = [...guidePages].filter((g) => !linkedGuides.has(g));
  if (deadLinks.length > 0 || unlisted.length > 0) {
    throw new Error(
      "guide sidebar drift:" +
        (deadLinks.length > 0 ? ` links without pages: ${deadLinks.join(", ")}.` : "") +
        (unlisted.length > 0 ? ` pages without links: ${unlisted.join(", ")}.` : "") +
        " Update the sidebar in scripts/docs-gen.mjs.",
    );
  }

  mkdirSync(dirname(sidebarFile), { recursive: true });
  writeFileSync(sidebarFile, `${JSON.stringify(sidebar, null, 2)}\n`);

  process.stdout.write(
    `\nGenerated docs for ${pkgs.length} package(s) → ${relative(repoRoot, genPackagesDir)}\n` +
      `Sidebar → ${relative(repoRoot, sidebarFile)}\n`,
  );
}

main();
