// Scaffold an in-repo demo app into demos/<slug>.
//
// Usage: pnpm new-demo <name> [--description "..."]
//
// The internal twin of `pnpm create @habemus-papadum/aiui`. Same template, same
// starter app — wired to this checkout instead of the registry. Where the public
// scaffolder pins `@habemus-papadum/*` to a published range and makes the target
// its own git repo, this one resolves them with `workspace:^` (editable,
// source-first, no build step) and leaves the app in this repo's history.
//
// It reuses create-aiui's `scaffoldApp`/`templateRoot` rather than keeping a
// second copy of the starter, so fixing the template fixes both paths. That is
// why this is TypeScript run through tsx (see the `new-demo` root script) while
// its sibling new-package.mjs is plain node: the template's scaffolder is TS.
//
// Two invariants worth knowing before you edit this file:
//
//   - Demos are never published. The template's package.json already carries
//     `"private": true` — npm's own opt-out, which makes `pnpm -r publish` skip
//     the package. Nothing else is needed, and no publishConfig belongs here.
//   - Demos DO join version lockstep. scripts/versioning.mjs derives its package
//     set from the `packages:` globs in pnpm-workspace.yaml, and `demos/*` is one
//     of them — so a demo without the shared version fails `pnpm version:check`
//     in CI. We stamp it at creation; the release pipeline rewrites it after.

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scaffoldApp, templateRoot } from "../packages/create-aiui/src/scaffold";
import { currentVersion, deriveContext, fail, repoRoot, slugify } from "./lib/common.mjs";

const USAGE = 'usage: pnpm new-demo <name> [--description "..."]';

function parseArgs(argv: string[]): { name: string; description?: string } {
  let name: string | undefined;
  let description: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--description") {
      description = argv[++i] ?? description;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    } else if (!arg.startsWith("--") && !name) {
      name = arg;
    } else {
      fail(`unexpected argument "${arg}"`);
    }
  }
  if (!name) {
    fail(USAGE);
  }
  return { name, description };
}

/**
 * Rewrite the scaffolded package.json for life inside the workspace.
 *
 * Dependency *ranges* are already `workspace:^` (scaffoldApp resolved the token);
 * the dependency *sets* are the template's, untouched, so the two scaffolders
 * can't drift on what the starter app needs. Everything else is replaced:
 *
 *  - scripts run the CLI through `bin/aiui`, the repo's source-run launcher. The
 *    `aiui` bin resolves to `dist/cli.js` by convention (CLAUDE.md → *Workspace
 *    dependencies are editable*), which doesn't exist in a fresh checkout, so a
 *    demo can't call the bare `aiui` its published sibling calls.
 *  - the `aiui.scaffold` marker goes away. It only exists so `pnpm create` can
 *    *continue* a scaffold instead of clobbering it; this script refuses an
 *    existing directory outright, and dropping the marker makes create-aiui
 *    classify a demo as `occupied` — exactly right, it should never touch one.
 */
function rewirePackageJson(
  dest: string,
  slug: string,
  description: string,
  version: string,
  { scope, repoUrl }: { scope: string; repoUrl: string },
): void {
  const pkgPath = join(dest, "package.json");
  const template = JSON.parse(readFileSync(pkgPath, "utf8")) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  const pkg = {
    name: `${scope}/demo-${slug}`,
    version,
    description,
    private: true,
    type: "module",
    license: "MIT",
    repository: { type: "git", url: repoUrl, directory: `demos/${slug}` },
    scripts: {
      claude: "../../bin/aiui claude",
      dev: "vite",
      open: "../../bin/aiui open",
      test: "vitest run",
      typecheck: "tsc --noEmit -p tsconfig.json",
    },
    dependencies: template.dependencies,
    devDependencies: template.devDependencies,
  };
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
}

/**
 * The in-repo tsconfig: inherit the workspace's compiler options, as every
 * package does, instead of the template's standalone copy. Written as literal
 * text rather than JSON.stringify'd — biome formats single-element arrays inline,
 * and a scaffold that fails `pnpm lint` on creation is a bad first impression.
 */
const TSCONFIG = `{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "noEmit": true,
    "jsx": "preserve",
    "jsxImportSource": "@solidjs/web",
    "types": ["vite/client"]
  },
  "include": ["src"]
}
`;

/**
 * The demo's CLAUDE.md, DERIVED from the template's own (which scaffoldApp
 * just copied into place) rather than re-written here: the shared rules —
 * scenery reset, the playbook, the ground rules — flow through verbatim from
 * their one source, and only the demo-specific delta is authored here. The
 * anchors are asserted so a template rewrite fails this script loudly instead
 * of silently shipping a mis-spliced doc.
 */
function claudeMd(slug: string, scaffolded: string): string {
  const title = "# an aiui starter app";
  const introEnd = "be careful about the wiring underneath.";
  if (!scaffolded.startsWith(title)) {
    fail(`template CLAUDE.md no longer opens with "${title}" — update new-demo.ts's splice`);
  }
  const introCut = scaffolded.indexOf(introEnd);
  if (introCut === -1) {
    fail(`template CLAUDE.md intro anchor ("${introEnd}") not found — update new-demo.ts's splice`);
  }
  const shared = scaffolded
    .slice(introCut + introEnd.length)
    .trimStart()
    // The demo workspace runs pnpm (the sandbox text says npm).
    .replaceAll("npm run typecheck && npm test", "pnpm typecheck && pnpm test");
  return `# demo: ${slug}

An in-repo demo app, scaffolded by \`pnpm new-demo\` from the same starter template
\`create-aiui\` ships. Its visible content — the banner, the rose — is **placeholder scenery meant
to be replaced** by whatever this demo is for. Be bold about rebuilding the page; be careful about
the wiring underneath.

It differs from a scaffolded sandbox in exactly two ways, both deliberate:

- \`@habemus-papadum/*\` deps resolve through \`workspace:^\` — you are editing the real packages
  next door, live, with no build step. A change to \`packages/aiui-viz\` shows up here on save.
- It lives in this repo's git history. Commits here are commits to pdum_aiui.

Run the dev server with \`pnpm dev\` from this directory (plain \`vite\`); the intent client
reaches the channel through the channel-served \`/intent/\` page or the side panel, so the dev
server needs no channel wiring of its own.

${shared}`;
}

function readmeMd(slug: string, description: string): string {
  return `# demo: ${slug}

${description}

An in-repo demo wired to the workspace (\`workspace:^\`, no npm install of aiui packages, no build
step). Run the loop from this directory:

\`\`\`sh
pnpm claude   # terminal 1 — Claude Code with the aiui channel + session browser
pnpm dev      # terminal 2 — this app (Vite + the intent tool)
\`\`\`

Then open it in the session browser — the window you share with the agent:

\`\`\`sh
./aiui open http://localhost:5173   # from the repo root
\`\`\`

Activate the intent client (**⌘B**) and describe
what you want. See [docs/guide/getting-started.md](../../docs/guide/getting-started.md).
`;
}

function main(): void {
  const { name, description: given } = parseArgs(process.argv.slice(2));
  const slug = slugify(name);
  if (!slug) {
    fail(`"${name}" slugifies to an empty string`);
  }
  const description = given ?? `In-repo aiui demo: ${slug}.`;
  const dest = join(repoRoot, "demos", slug);
  if (existsSync(dest)) {
    fail(`demos/${slug} already exists`);
  }

  const template = templateRoot();
  if (!template) {
    fail("could not find create-aiui's app template");
  }

  const version = currentVersion();
  scaffoldApp(template, dest, version, "workspace:^");

  rewirePackageJson(dest, slug, description, version, deriveContext());
  writeFileSync(join(dest, "tsconfig.json"), TSCONFIG);
  writeFileSync(
    join(dest, "CLAUDE.md"),
    claudeMd(slug, readFileSync(join(dest, "CLAUDE.md"), "utf8")),
  );
  writeFileSync(join(dest, "README.md"), readmeMd(slug, description));

  const indexPath = join(dest, "index.html");
  writeFileSync(
    indexPath,
    readFileSync(indexPath, "utf8").replace(
      /<title>.*<\/title>/,
      `<title>${slug} — an aiui demo</title>`,
    ),
  );

  // The sandbox's own dot-files: the repo root already ignores node_modules/,
  // dist/, and .aiui-cache/, and a demo in source control isn't a sandbox.
  for (const dotfile of [".gitignore", ".envrc"]) {
    rmSync(join(dest, dotfile), { force: true });
  }

  process.stdout.write(
    `Created demos/${slug} (${deriveContext().scope}/demo-${slug} @ ${version}) [no-publish]\n` +
      "Next:\n" +
      "  pnpm install                 # link the new workspace member\n" +
      `  pnpm -C demos/${slug} claude    # terminal 1 — Claude Code + channel\n` +
      `  pnpm -C demos/${slug} dev       # terminal 2 — Vite + the intent tool\n`,
  );
}

main();
