#!/usr/bin/env node
/**
 * Packaging test: is this repo actually consumable from npm?
 *
 * The unit suite exercises source; this exercises the *artifacts*. It builds
 * everything, `pnpm pack`s every publishable package, installs the tarballs
 * into a scratch npm project (dependencies resolve between the tarballs; the
 * registry only serves third-party deps), and then drives the installed CLIs
 * the way a consumer would — no Claude Code, no browser, just "do the bins
 * run and did the right files ship". Run it with `pnpm test:packaging`.
 *
 * What it catches that nothing else does: a missing `files` entry (the
 * a package shipping without its built assets), a bin that only
 * resolves in the workspace layout, a workspace:^ range that doesn't convert,
 * a dependency that should have been a devDependency.
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
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const keep = process.argv.includes("--keep");

const work = mkdtempSync(join(tmpdir(), "aiui-packaging-"));
const tarballDir = join(work, "tarballs");
const scratch = join(work, "scratch");
const cache = join(work, "aiui-cache");
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
// A consumer-shaped environment: node available, `claude` NOT on the PATH,
// and the aiui user cache sandboxed into the work dir.
const env = {
  ...process.env,
  PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter),
  AIUI_CACHE: cache,
  CI: "", // exercise the not-CI path (still non-interactive: no TTY, no prompts)
};
const aiui = join(scratch, "node_modules", ".bin", "aiui");
const run = (args) =>
  spawnSync(aiui, args, { cwd: scratch, env, encoding: "utf8", timeout: 120_000 });

// Every conditional-exports object in a PACKED manifest must carry a "default"
// condition: require.resolve() (which the CLI uses on sidecar subpaths) matches
// CJS conditions and throws ERR_PACKAGE_PATH_NOT_EXPORTED without it. Dev never
// catches this — the source-first exports are bare strings that match anything.
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

console.log("driving the installed CLI…");
check("aiui bin exists", existsSync(aiui));

const help = run(["--help"]);
check("aiui --help exits 0", help.status === 0, help.stderr);
check(
  "aiui --help lists chrome + claude",
  /chrome/.test(help.stdout) && /claude/.test(help.stdout),
);

const marketplace = join(
  scratch,
  "node_modules",
  "@habemus-papadum",
  "aiui-claude-plugin",
  "marketplace",
);
check(
  "packed plugin marketplace ships its manifest and plugins",
  existsSync(join(marketplace, ".claude-plugin", "marketplace.json")) &&
    existsSync(join(marketplace, "plugins", "aiui", ".claude-plugin", "plugin.json")) &&
    existsSync(
      join(marketplace, "plugins", "frontend-design", "skills", "frontend-design", "SKILL.md"),
    ) &&
    existsSync(
      join(marketplace, "plugins", "session-browser", "skills", "session-browser", "SKILL.md"),
    ),
  marketplace,
);

const status = run(["chrome", "status"]);
check("aiui chrome status exits 0", status.status === 0, status.stderr);
check("status reports the intent client", /intent client/.test(status.stdout));
// The published intent-client tarball must carry its BUILT MV3 bundle
// (dist-ext/), not just resolve the package: an installed `aiui claude` loads
// the extension from there, so a missing bundle is the "no MV3 bundle yet"
// regression. Guards both gaps at once — `dist-ext` in the package `files`, and
// `build:ext` running as part of `build` (which `pnpm -r run build` invoked above).
check(
  "the intent client ships its built MV3 bundle (dist-ext)",
  !/no MV3 bundle yet/.test(status.stdout) && /dist-ext/.test(status.stdout),
  status.stdout,
);

const claude = run(["claude"]);
check("aiui claude without claude on PATH fails politely", claude.status === 1);
check("…with the PATH explanation", /not found on your PATH/.test(claude.stderr), claude.stderr);

const mcp = run(["mcp", "--help"]);
check("aiui mcp --help (channel CLI from dist) exits 0", mcp.status === 0, mcp.stderr);

// The installed sidecar path, end to end: import every published `/sidecar`
// subpath the way the channel's standard-sidecars.ts does (bare subpath, no
// descriptors), construct each factory, and mount one — under plain node,
// from the packed tarballs. This is the dev/installed seam that source-first
// masks: in the workspace these resolve to src/*.ts under tsx; installed they
// must resolve to dist/*.js and import cleanly with no loader. The package
// set is DERIVED from the publishConfig exports (any package publishing a
// "./sidecar" subpath is in), so a new sidecar package is probed automatically.
const sidecarPackages = publishable
  .map((dir) => JSON.parse(readFileSync(join(dir, "package.json"), "utf8")))
  .filter((pkg) => pkg.publishConfig?.exports?.["./sidecar"] !== undefined)
  .map((pkg) => pkg.name)
  .sort();
if (sidecarPackages.length === 0) throw new Error("no packages publish a ./sidecar subpath");
const sidecarProbe = join(scratch, "sidecar-probe.mjs");
writeFileSync(
  sidecarProbe,
  `import { createRequire } from "node:module";
const names = ${JSON.stringify(sidecarPackages)};
const require = createRequire(import.meta.url);
const root = process.cwd();
const built = [];
for (const name of names) {
  const resolved = require.resolve(name + "/sidecar");
  if (!resolved.endsWith(".js")) throw new Error(name + "/sidecar: expected a dist .js path, got: " + resolved);
  const mod = await import(name + "/sidecar");
  // Each module's one factory export, exactly what standardSidecars calls.
  const factory = Object.values(mod).find((v) => typeof v === "function");
  if (factory === undefined) throw new Error(name + "/sidecar exports no factory");
  built.push({ name, sidecar: factory({ root }) });
}
// Mount EVERY sidecar in prod mode on one app, the way the channel does. A
// mount that throws is the exact failure the channel logs-and-skips at
// runtime (the v0.8.0 dashboard 404: Vite had rewritten the sidecars'
// new URL(rel, import.meta.url) paths into data: URLs, so prod mounts threw
// under plain node while source-first dev hid it) — here it must be fatal.
const express = (await import("express")).default;
const app = express();
const mounted = [];
for (const { name, sidecar } of built) {
  try {
    mounted.push(await sidecar.mount(app, { mode: "prod", log: () => {}, port: () => undefined }));
  } catch (err) {
    throw new Error(name + "/sidecar failed to mount in prod mode: " + (err?.message ?? err));
  }
}
// And the client surfaces must actually answer with their built bundles —
// a 503 here means a package shipped without its assets/ directory.
const server = app.listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const port = server.address().port;
for (const path of ["/__aiui/", "/intent/", "/pencil/"]) {
  const res = await fetch("http://127.0.0.1:" + port + path);
  const body = await res.text();
  if (res.status !== 200) throw new Error("GET " + path + " -> " + res.status + ": " + body.slice(0, 200));
}
const redirect = await fetch("http://127.0.0.1:" + port + "/", { redirect: "manual" });
if (redirect.status !== 302) throw new Error("GET / -> " + redirect.status + " (expected the console redirect)");
for (const m of mounted) await m.dispose?.();
server.close();
console.log(names.join(" "));
`,
);
const probe = spawnSync(process.execPath, [sidecarProbe], {
  cwd: scratch,
  env,
  encoding: "utf8",
  timeout: 60_000,
});
check(
  `every published /sidecar subpath (${sidecarPackages.length}) resolves to dist, mounts in prod mode, and serves its client`,
  probe.status === 0 && sidecarPackages.every((name) => probe.stdout.includes(name)),
  probe.stderr || probe.stdout,
);

// The create-aiui scaffolder, from its own installed bin: templates/ shipped,
// dot-files restored (.gitignore AND .envrc), tokens resolved, continuation.
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
    !readFileSync(join(scratch, "starter-app", "package.json"), "utf8").includes("__AIUI"),
);
const createdAgain = runCreate(["starter-app", "--skip-install"]);
check(
  "re-running create-aiui continues instead of re-scaffolding",
  createdAgain.status === 0 && /continuing/.test(createdAgain.stderr + createdAgain.stdout),
  createdAgain.stderr,
);

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
