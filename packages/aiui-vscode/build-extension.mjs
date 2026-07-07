/**
 * Stage the installable VS Code extension under `dist/extension/`:
 * extension.ts (plus its workspace deps, read source-first — no build step in
 * the dep packages) bundled to CommonJS with only `vscode` external, next to a
 * VS Code-ready manifest derived from package.json.
 *
 * Why a derived manifest: this package is *both* an npm library (scoped name,
 * source-first dev exports, `publishConfig` dist mapping — the repo-wide
 * convention) and a VS Code extension, and the two disagree about
 * package.json. VS Code needs an unscoped `name` (the extension id is
 * `publisher.name`) and a `main` pointing at the bundle; npm needs the scoped
 * name and must never see extension `main`. So package.json stays the single
 * source of truth (including `contributes`/`engines`/`activationEvents`,
 * which npm ignores), and this script swaps the npm-specific fields out.
 *
 * `--vsix` additionally packs the staged folder into `dist/aiui-vscode.vsix`
 * with vsce (`--no-dependencies`: the bundle already inlined everything), and
 * `--install` then hands that .vsix to `code --install-extension`. `--link`
 * instead symlinks the staged folder into `~/.vscode/extensions/` — the
 * live-dev install, where a rebuild + window reload picks up changes with no
 * repackaging. The pnpm spellings: `install:vsix` and `install:dir` (or, from
 * the repo root, `vscode:install` / `vscode:link`).
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = fileURLToPath(new URL(".", import.meta.url));
const outDir = `${here}dist/extension`;
const pkg = JSON.parse(readFileSync(`${here}package.json`, "utf8"));

await build({
  entryPoints: [`${here}src/extension.ts`],
  outfile: `${outDir}/extension.cjs`,
  bundle: true,
  format: "cjs",
  platform: "node",
  // VS Code ^1.90 hosts extensions on Node 20.
  target: "node20",
  external: ["vscode"],
  sourcemap: true,
  minify: false,
  logLevel: "info",
  // aiui-util's provenance module uses import.meta at module top level, which
  // is empty under the cjs format — but that module is tree-shaken out of this
  // bundle (`sideEffects: false`), so the transform-stage warning is noise.
  // The assertion below guards the assumption instead.
  logOverride: { "empty-import-meta": "silent" },
});

const bundle = readFileSync(`${outDir}/extension.cjs`, "utf8");
if (bundle.includes("import.meta") || bundle.includes("import_meta")) {
  throw new Error(
    "dist/extension/extension.cjs retains import.meta, which is empty under cjs — " +
      "a dependency with module-level side effects crept into the bundle",
  );
}

const manifest = {
  name: "aiui-vscode",
  displayName: pkg.displayName,
  description: pkg.description,
  // The lockstep version carries `+dev` build metadata; vsix versions don't.
  version: pkg.version.replace(/\+.*$/, ""),
  publisher: pkg.publisher,
  license: pkg.license,
  repository: pkg.repository,
  engines: { vscode: pkg.engines.vscode },
  categories: pkg.categories,
  activationEvents: pkg.activationEvents,
  contributes: pkg.contributes,
  main: "./extension.cjs",
};
writeFileSync(`${outDir}/package.json`, `${JSON.stringify(manifest, null, 2)}\n`);
copyFileSync(`${here}README.md`, `${outDir}/README.md`);
copyFileSync(`${here}../../LICENSE`, `${outDir}/LICENSE`);

if (process.argv.includes("--vsix")) {
  mkdirSync(`${here}dist`, { recursive: true });
  const vsce = `${here}node_modules/.bin/vsce`;
  const result = spawnSync(
    vsce,
    ["package", "--no-dependencies", "-o", `${here}dist/aiui-vscode.vsix`],
    { cwd: outDir, stdio: "inherit" },
  );
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
  if (process.argv.includes("--install")) {
    const installed = spawnSync("code", ["--install-extension", `${here}dist/aiui-vscode.vsix`], {
      stdio: "inherit",
    });
    if (installed.error) {
      process.stderr.write(
        "\ncould not run `code` — is the VS Code CLI on your PATH? " +
          "(VS Code: ⇧⌘P → \"Shell Command: Install 'code' command in PATH\")\n",
      );
      process.exit(1);
    }
    if (installed.status !== 0) {
      process.exit(installed.status ?? 1);
    }
    process.stdout.write("\nInstalled — reload the VS Code window to activate it.\n");
  } else {
    process.stdout.write(
      "\nInstall it with: code --install-extension packages/aiui-vscode/dist/aiui-vscode.vsix\n",
    );
  }
}

if (process.argv.includes("--link")) {
  // The live-dev install: VS Code loads any extensions-dir folder with a
  // valid manifest, and it follows symlinks — so link the staged folder once
  // and every rebuild lands on the next window reload. Unversioned link name
  // on purpose: re-linking stays idempotent across version bumps.
  const link = join(homedir(), ".vscode", "extensions", "habemus-papadum.aiui-vscode");
  mkdirSync(join(homedir(), ".vscode", "extensions"), { recursive: true });
  rmSync(link, { force: true, recursive: true });
  symlinkSync(outDir, link, "dir");
  process.stdout.write(
    `\nLinked ${link} → dist/extension/\n` +
      "Reload the VS Code window to activate; after future rebuilds just reload again.\n" +
      "(Uninstall the .vsix copy first if both are present, or VS Code sees two aiui extensions.)\n",
  );
}
