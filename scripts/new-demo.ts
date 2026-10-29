// Scaffold an in-repo demo app into demos/<slug>.
//
// Usage: pnpm new-demo <name> [--description "..."]
//
// The internal twin of `pnpm create @habemus-papadum/aiui`. Same template, same
// starter app — wired to this checkout instead of the registry. Where the public
// scaffolder pins `@habemus-papadum/*` to a published range and makes the target
// its own git repo, this one resolves them with workspace floors
// (`workspace:>=X.Y.Z`, which pnpm links to the checkout: editable, source-first,
// no build step) and leaves the app in this repo's history.
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
//   - Demos carry version 0.0.0. ship (which releases the packages) ignores a
//     private workspace member, so nothing ever rewrites a demo's version; its
//     dependencies on siblings are floors on each sibling's last release
//     (`workspace:>=0.24.0`) or `workspace:>=0.0.0` for a sibling that is itself
//     private and never released.

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scaffoldApp, templateRoot } from "../packages/create-aiui/src/scaffold";
import {
  catalogRefs,
  deriveContext,
  fail,
  repoRoot,
  slugify,
  workspaceFloors,
} from "./lib/common.mjs";

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
 * Dependency *ranges* are already workspace floors (scaffoldApp resolved the token);
 * the dependency *sets* are the template's, untouched, so the two scaffolders
 * can't drift on what the starter app needs. Everything else is replaced:
 *
 *  - scripts are the demo's own set (dev/test/typecheck) — the same three the
 *    template ships, restated here so this file, not the template, owns what an
 *    in-repo demo runs.
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
  floors: Map<string, string>,
): void {
  const pkgPath = join(dest, "package.json");
  const template = JSON.parse(readFileSync(pkgPath, "utf8")) as {
    aiui?: { sitePage?: Record<string, unknown> };
    exports: Record<string, string>;
    main: string;
    module: string;
    types: string;
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
    // The dual shape flows through from the template: the library exports and
    // the `aiui.sitePage` marker (already token-resolved to this slug), which
    // makes the gallery shell discover and mount the new demo automatically.
    // Only `aiui.scaffold` is dropped — see the function doc above.
    exports: template.exports,
    main: template.main,
    module: template.module,
    types: template.types,
    ...(template.aiui?.sitePage ? { aiui: { sitePage: template.aiui.sitePage } } : {}),
    scripts: {
      dev: "vite",
      test: "vitest run",
      typecheck: "tsc --noEmit -p tsconfig.json",
    },
    dependencies: withCatalogRefs(withVoiceDock(template.dependencies, floors)),
    devDependencies: withCatalogRefs(template.devDependencies),
  };
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
}

const VOICE_DOCK = "@habemus-papadum/aiui-dock";

/**
 * The in-repo demo's one dependency beyond the template's: the voice dock. The
 * template ships without it — a consumer's app decides its own voice surface —
 * and a demo in this repo is where the dock is exercised, so it is added here
 * (see {@link injectVoiceDock} for the source side). Asserted absent from the
 * template so a template that grows the dock back fails this script loudly.
 */
function withVoiceDock(
  deps: Record<string, string>,
  floors: Map<string, string>,
): Record<string, string> {
  if (VOICE_DOCK in deps) {
    fail(`the template depends on ${VOICE_DOCK} itself — update new-demo.ts's dock injection`);
  }
  const dock = floors.get(VOICE_DOCK);
  if (!dock) {
    fail(`${VOICE_DOCK} is not a workspace member — update new-demo.ts's dock injection`);
  }
  return Object.fromEntries(
    Object.entries({ ...deps, [VOICE_DOCK]: dock }).sort(([a], [b]) => a.localeCompare(b)),
  );
}

/**
 * Mount the voice dock in the scaffolded demo: the import and the element in
 * `src/main.tsx`, and the `devKeys` opt-in in `vite.config.ts` that hands the
 * dev server's OpenAI key to the page (what the demo README promises). Same
 * anchored-replacement discipline as {@link claudeMd}: every anchor must occur
 * exactly once, or the template changed under this script and it stops here.
 */
function injectVoiceDock(dest: string): void {
  const splice = (file: string, edits: ReadonlyArray<readonly [string, string]>): void => {
    const path = join(dest, file);
    let text = readFileSync(path, "utf8");
    if (text.includes(VOICE_DOCK)) {
      fail(`template ${file} carries the voice dock itself — update new-demo.ts's dock injection`);
    }
    for (const [anchor, replacement] of edits) {
      if (text.split(anchor).length !== 2) {
        fail(
          `template ${file} anchor not found once (${JSON.stringify(anchor)}) — update new-demo.ts's dock injection`,
        );
      }
      text = text.replace(anchor, replacement);
    }
    writeFileSync(path, text);
  };
  const importAnchor = 'import { PageBoundary } from "@habemus-papadum/aiui-viz";\n';
  const mountAnchor = "      <page.App />\n";
  splice("src/main.tsx", [
    [importAnchor, `import { VoiceDock } from "${VOICE_DOCK}";\n${importAnchor}`],
    [mountAnchor, `${mountAnchor}      <VoiceDock />\n`],
  ]);
  splice("vite.config.ts", [
    ["plugins: [aiui(), solid()]", 'plugins: [aiui({ devKeys: ["openai"] }), solid()]'],
  ]);
}

/**
 * Swap the template's literal pins for the root workspace's catalog references
 * wherever a catalog entry exists (`catalog:solid` for the Solid lockstep set,
 * `catalog:` for shared singletons like vite/typescript/vitest).
 *
 * The template itself keeps literal pins on purpose — its package.json ships
 * inside create-aiui as an asset that npm/yarn must also parse, and `catalog:`
 * is pnpm-only. A demo lives in THIS workspace, where the catalogs are the
 * source of truth; freezing the template's literals into a demo would fork it
 * from the lockstep the moment a catalog bumps.
 */
function withCatalogRefs(deps: Record<string, string>): Record<string, string> {
  const refs = catalogRefs();
  return Object.fromEntries(
    Object.entries(deps).map(([name, range]) => [
      name,
      range.startsWith("workspace:") ? range : (refs.get(name) ?? range),
    ]),
  );
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

- \`@habemus-papadum/*\` deps are workspace floors (\`workspace:>=X.Y.Z\`), which pnpm links to the
  packages next door — you are editing them live, with no build step. A change to
  \`packages/aiui-viz\` shows up here on save.
- It lives in this repo's git history. Commits here are commits to pdum_aiui.

Run the dev server with \`pnpm dev\` from this directory (plain \`vite\`); the voice dock takes its
OpenAI key from \`OPENAI_API_KEY\` in the environment (the \`devKeys\` opt-in in \`vite.config.ts\`) or
from its own key pane.

${shared}`;
}

function readmeMd(slug: string, description: string): string {
  return `# demo: ${slug}

${description}

An in-repo demo wired to the workspace (\`workspace:>=X.Y.Z\` floors that pnpm links to the
checkout: no npm install of aiui packages, no build step). Run it from this directory:

\`\`\`sh
pnpm dev      # this app (Vite)
\`\`\`

Open the printed URL. The voice dock in the corner drives the page's own tools; it takes an OpenAI
key from \`OPENAI_API_KEY\` in the environment (the dev server hands it to the page) or from its own
key pane. See the [user guide](../../packages/aiui-viz/docs/frontend-user-guide.md).
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

  // A demo is private: ship ignores it and its version stays 0.0.0. Its aiui
  // dependencies are floors on the siblings' own release lines.
  const version = "0.0.0";
  const floors = workspaceFloors();
  scaffoldApp(template, dest, (name) => {
    const floor = floors.get(name);
    if (!floor) {
      fail(`${name} is not a workspace member — the template depends on it`);
    }
    return floor;
  });

  rewirePackageJson(dest, slug, description, version, deriveContext(), floors);
  injectVoiceDock(dest);
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
  // pnpm-workspace.yaml goes too: a standalone scaffold needs it (build-script
  // allowances for esbuild), but inside demos/<slug> it would be a workspace
  // *boundary marker* — pnpm walking up from the demo would stop there instead
  // of the repo root, severing every workspace:^ dep (the trick bootstrap/
  // plays on purpose). The root workspace already allows esbuild's build.
  for (const dotfile of [".gitignore", ".envrc", "pnpm-workspace.yaml"]) {
    rmSync(join(dest, dotfile), { force: true });
  }

  process.stdout.write(
    `Created demos/${slug} (${deriveContext().scope}/demo-${slug} @ ${version}) [no-publish]\n` +
      "Next:\n" +
      "  pnpm install                 # link the new workspace member\n" +
      `  pnpm -C demos/${slug} dev       # Vite; OPENAI_API_KEY in the environment feeds the voice dock\n` +
      "The scaffold carries the aiui.sitePage marker, so the gallery shell\n" +
      "(pnpm demo) discovers it as a tab on its next dev-server start.\n",
  );
}

main();
