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

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scaffoldApp, templateRoot } from "../packages/create-aiui/src/scaffold";

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, "..");

const USAGE = 'usage: pnpm new-demo <name> [--description "..."]';

function fail(message: string): never {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

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

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** The npm scope and repo URL, read off the CLI package rather than hardcoded. */
function deriveContext(): { scope: string; repoUrl: string } {
  const pkg = JSON.parse(
    readFileSync(join(repoRoot, "packages", "aiui", "package.json"), "utf8"),
  ) as { name: string; repository?: { url?: string } };
  const scope = pkg.name.split("/")[0];
  return { scope, repoUrl: pkg.repository?.url ?? "" };
}

/** The single lockstep version every workspace member must carry. */
function currentVersion(): string {
  return execFileSync("node", [join(scriptsDir, "versioning.mjs"), "current"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
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
      dev: "../../bin/aiui vite dev",
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

function claudeMd(slug: string): string {
  return `# demo: ${slug}

An in-repo demo app, scaffolded by \`pnpm new-demo\` from the same starter template
\`create-aiui\` ships. Its visible content — the banner, the rose — is **placeholder scenery meant
to be replaced** by whatever this demo is for. Be bold about rebuilding the page; be careful about
the wiring underneath.

**Reset to a blank canvas (mechanical — no code reasoning), applied under \`src/\` only:**
1) delete every file whose first line contains \`<aiui-scenery-file>\`; 2) in the remaining
\`src/\` files, delete each block from a line containing \`<aiui-scenery>\` through the next
line containing \`</aiui-scenery>\`, inclusive of both marker lines; 3) \`pnpm typecheck &&
pnpm test\` (a blank app passes both). Touch nothing else — docs like this one merely mention
the markers.

It differs from a scaffolded sandbox in exactly two ways, both deliberate:

- \`@habemus-papadum/*\` deps resolve through \`workspace:^\` — you are editing the real packages
  next door, live, with no build step. A change to \`packages/aiui-viz\` shows up here on save.
- It lives in this repo's git history. Commits here are commits to pdum_aiui.

Ground rules (the same ones the starter ships with):

- **Don't remove the integration.** The \`aiui()\` plugin in \`vite.config.ts\` (from
  \`@habemus-papadum/aiui-source-processor\`) stamps JSX with \`data-source-loc\` and injects
  \`cell()\`/\`control()\`/\`action()\` identities; connectivity arrives from the intent client over
  this session's channel. The loop stops working without it. (And never hand-write a
  \`data-source-loc\`/\`data-cell-loc\` — locations are compiler output.)
- **Keep the architecture's split.** \`src/model/store.ts\` holds the *durable roots* AND the
  **control surface**: user-movable parameters are \`control({ value, min, max, … })\` with a real
  doc comment (the compiler injects the name from the binding and lifts the comment as the
  description). Internal state stays \`durableSignal()\`/\`durable()\` — the surface is curated.
  \`src/model/graph.ts\` is *disposable logic*: the cell graph, built by \`hotCellGraph()\` and
  rebuilt over the roots on every hot edit. UI components in \`src/ui/\` are freely hot-swappable,
  read cells through the \`graph()\` accessor (never by importing one directly), and bind controls
  through \`ControlSlider\`/\`ControlToggle\` (bounds from the control's meta — never re-state
  min/max in JSX) or a hand-rolled binding for shapes those don't fit.
- **Declaring IS exposing.** Every \`control()\` is settable and every \`action()\` is a real named
  agent tool automatically via \`registerStandardTools\` (\`report\`/\`set\`/\`locate\` + one tool
  per action). Do NOT hand-write get-params/set-params tools; reserve \`kit.registerTool\` for the
  rare genuinely-bespoke case.
- **Test the surface with the cells.** \`resetControlSurface()\` in afterEach, build cells inside
  \`cellHarness\`, probe each input.
- Run the dev server with \`pnpm dev\` from this directory (\`bin/aiui vite dev\` — it injects the
  channel port as \`VITE_AIUI_PORT\`). Plain \`vite\` also serves the app, but the intent tool won't
  find the channel.

Methodology: [docs/guide/frontend-for-agents.md](../../docs/guide/frontend-for-agents.md).
`;
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
  writeFileSync(join(dest, "CLAUDE.md"), claudeMd(slug));
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
