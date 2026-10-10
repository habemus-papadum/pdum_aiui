#!/usr/bin/env node
/**
 * Packaging test: is this repo actually consumable from npm?
 *
 * The unit suite exercises source; this exercises the *artifacts*. It builds
 * everything, `pnpm pack`s every publishable package, installs the tarballs
 * into a scratch npm project (dependencies resolve between the tarballs; the
 * registry only serves third-party deps), and then probes the installed
 * packages the way a consumer would — no browser, just "do the subpaths
 * resolve, does the bin run, and did the right files ship". Run it with
 * `pnpm test:packaging`.
 *
 * What it catches that nothing else does: a missing `files` entry (a package
 * shipping without its built assets), a subpath that only resolves in the
 * workspace layout, a workspace:^ range that doesn't convert, a dependency
 * that should have been a devDependency.
 *
 * Flags: --keep leaves the scratch directory behind and prints its path.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const keep = process.argv.includes("--keep");

const work = mkdtempSync(join(tmpdir(), "aiui-packaging-"));
const tarballDir = join(work, "tarballs");
const scratch = join(work, "scratch");
mkdirSync(tarballDir);
mkdirSync(scratch);

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ✓" : "  ✗"} ${label}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
};

// ---------------------------------------------------------------- build & pack
console.log("building workspace…");
execFileSync("pnpm", ["-r", "run", "build"], { cwd: repoRoot, stdio: "inherit" });

const publishable = readdirSync(join(repoRoot, "packages"), { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => join(repoRoot, "packages", e.name))
  .filter((dir) => {
    try {
      return !JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).private;
    } catch {
      return false;
    }
  });

console.log(`packing ${publishable.length} publishable packages…`);
for (const dir of publishable) {
  execFileSync("pnpm", ["pack", "--pack-destination", tarballDir], { cwd: dir, stdio: "pipe" });
}
const tarballs = readdirSync(tarballDir).map((f) => join(tarballDir, f));

// ------------------------------------------------------------------- install
console.log(`installing ${tarballs.length} tarballs into a scratch project…`);
writeFileSync(
  join(scratch, "package.json"),
  `${JSON.stringify({ name: "aiui-packaging-scratch", private: true }, null, 2)}\n`,
);
execFileSync("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error", ...tarballs], {
  cwd: scratch,
  stdio: "inherit",
});

// -------------------------------------------------------------------- checks
// A consumer-shaped environment: node available and nothing else on the PATH.
const env = {
  ...process.env,
  PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter),
  CI: "", // exercise the not-CI path (still non-interactive: no TTY, no prompts)
};

// Every conditional-exports object in a PACKED manifest must carry a "default"
// condition: require.resolve() (which a consuming host uses on subpaths such
// as `/sidecar`) matches CJS conditions and throws ERR_PACKAGE_PATH_NOT_EXPORTED
// without it. Dev never catches this — the source-first exports are bare
// strings that match anything.
const scopeDir = join(scratch, "node_modules", "@habemus-papadum");
const conditionalWithoutDefault = [];
for (const name of readdirSync(scopeDir)) {
  const manifest = JSON.parse(readFileSync(join(scopeDir, name, "package.json"), "utf8"));
  for (const [subpath, cond] of Object.entries(manifest.exports ?? {})) {
    if (cond !== null && typeof cond === "object" && !("default" in cond)) {
      conditionalWithoutDefault.push(`${name}: "${subpath}"`);
    }
  }
}
check(
  "every packed conditional export carries a default condition",
  conditionalWithoutDefault.length === 0,
  conditionalWithoutDefault.join(", "),
);

// Every published `./sidecar` subpath must resolve, from the installed
// package, to a BUILT dist file. This is the dev/installed seam that
// source-first masks: in the workspace these subpaths resolve to src/*.ts
// under tsx; installed they must resolve to dist/*.js — and resolve at all,
// which is what the "default" condition above is about. The package set is
// DERIVED from the publishConfig exports (any package publishing a
// "./sidecar" subpath is in), so a new sidecar package is probed
// automatically. Resolution only: mounting a sidecar is the consuming host's
// job, not this repo's.
console.log("resolving the installed sidecar subpaths…");
const sidecarPackages = publishable
  .map((dir) => JSON.parse(readFileSync(join(dir, "package.json"), "utf8")))
  .filter((pkg) => pkg.publishConfig?.exports?.["./sidecar"] !== undefined)
  .map((pkg) => pkg.name)
  .sort();
if (sidecarPackages.length === 0) throw new Error("no packages publish a ./sidecar subpath");
const requireFromScratch = createRequire(join(scratch, "package.json"));
const sidecarProblems = [];
for (const name of sidecarPackages) {
  try {
    const resolved = requireFromScratch.resolve(`${name}/sidecar`);
    if (!resolved.endsWith(".js")) {
      sidecarProblems.push(`${name}/sidecar: expected a dist .js path, got ${resolved}`);
    } else if (!resolved.split(sep).includes("dist")) {
      sidecarProblems.push(`${name}/sidecar: resolved outside dist/: ${resolved}`);
    } else if (!existsSync(resolved)) {
      sidecarProblems.push(`${name}/sidecar: resolved to a file that did not ship: ${resolved}`);
    }
  } catch (err) {
    sidecarProblems.push(`${name}/sidecar: ${err?.message ?? err}`);
  }
}
check(
  `every published /sidecar subpath (${sidecarPackages.length}: ${sidecarPackages.join(", ")}) resolves to a shipped dist file`,
  sidecarProblems.length === 0,
  sidecarProblems.join("; "),
);

// The create-aiui scaffolder, from its own installed bin: templates/ shipped,
// dot-files restored (.gitignore AND .envrc), tokens resolved, continuation.
console.log("driving the installed create-aiui bin…");
const createBin = join(scratch, "node_modules", ".bin", "create-aiui");
const runCreate = (args) =>
  spawnSync(createBin, args, { cwd: scratch, env, encoding: "utf8", timeout: 120_000 });
check("create-aiui bin exists", existsSync(createBin));
const created = runCreate(["starter-app", "--skip-install"]);
check("create-aiui scaffolds from the shipped template", created.status === 0, created.stderr);
check(
  "starter has the app, restored .envrc/.gitignore, and resolved tokens",
  existsSync(join(scratch, "starter-app", "src", "main.tsx")) &&
    existsSync(join(scratch, "starter-app", ".envrc")) &&
    existsSync(join(scratch, "starter-app", ".gitignore")) &&
    !readFileSync(join(scratch, "starter-app", "package.json"), "utf8").includes("__AIUI") &&
    // Tokens are resolved across SOURCE too (scope("__APP_NAME__") → the slug).
    readFileSync(join(scratch, "starter-app", "src", "model", "store.ts"), "utf8").includes(
      'scope("starter-app")',
    ),
);
const createdAgain = runCreate(["starter-app", "--skip-install"]);
check(
  "re-running create-aiui continues instead of re-scaffolding",
  createdAgain.status === 0 && /continuing/.test(createdAgain.stderr + createdAgain.stdout),
  createdAgain.stderr,
);

// aibr's bin and pinned MCP dependency must resolve from an installed tarball,
// including paths with spaces. No browser or real agent is launched here.
const aibrBin = join(scratch, "node_modules", ".bin", "aibr");
const aibrHome = join(scratch, "aibr test data");
const runAibr = (args) =>
  spawnSync(aibrBin, args, {
    cwd: scratch,
    env: { ...env, AIBR_HOME: aibrHome },
    encoding: "utf8",
    timeout: 15_000,
  });
check("aibr bin exists", existsSync(aibrBin));
const aibrHelp = runAibr(["--help"]);
check(
  "installed aibr bin runs",
  aibrHelp.status === 0 && aibrHelp.stdout.includes("exec-based"),
  aibrHelp.stderr,
);
const aibrYolo = runAibr(["config", "yolo", "on"]);
check("installed aibr saves both agent defaults", aibrYolo.status === 0, aibrYolo.stderr);
const aibrConfig = runAibr(["config", "show"]);
const parsedAibr = aibrConfig.status === 0 ? JSON.parse(aibrConfig.stdout) : {};
check(
  "aibr defaults survive another process",
  parsedAibr.agents?.claude.yolo === true && parsedAibr.agents?.codex.yolo === true,
  aibrConfig.stderr,
);
const aibrProject = join(scratch, "aibr project");
mkdirSync(aibrProject);
const aibrProfile = runAibr([
  "profile",
  "create",
  "packaging",
  "--debug-port",
  "0",
  "--yes",
  "--use-here",
  aibrProject,
]);
check(
  "installed aibr writes a YAML project stub",
  aibrProfile.status === 0 && existsSync(join(aibrProject, ".aiui.yaml")),
  aibrProfile.stderr,
);
const aibrDoctor = runAibr(["doctor", "--json", "--cwd", aibrProject]);
const aibrReport = aibrDoctor.status === 0 ? JSON.parse(aibrDoctor.stdout) : {};
check(
  "installed aibr reads YAML and diagnoses a missing browser",
  aibrReport.current?.value?.label === "packaging" &&
    aibrReport.current?.value?.state === "missing browser",
  aibrDoctor.stderr,
);
const mcpProbe = spawnSync(
  process.execPath,
  [
    "--input-type=module",
    "-e",
    `
  import { mcpEntry } from '@habemus-papadum/aibr';
  import { existsSync } from 'node:fs';
  const entry = await mcpEntry({endpoint:'http://127.0.0.1:9222',wsEndpoint:'ws://127.0.0.1:9222/devtools/browser/test',browserVersion:'test'});
  if (!existsSync(entry.args[0])) process.exit(1);
`,
  ],
  { cwd: scratch, env, encoding: "utf8", timeout: 15_000 },
);
check("installed aibr resolves its pinned MCP executable", mcpProbe.status === 0, mcpProbe.stderr);

// -------------------------------------------------------------------- result
if (keep) {
  console.log(`scratch kept at ${work}`);
} else {
  rmSync(work, { recursive: true, force: true });
}
if (failures) {
  console.error(`\npackaging test: ${failures} check(s) failed`);
  process.exit(1);
}
console.log("\npackaging test: all checks passed");
