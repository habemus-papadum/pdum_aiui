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
 * aiui-devtools-extension shipping without its built `js/`), a bin that only
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
// condition: require.resolve() (which the CLI uses on the code sidecar) matches
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

const ext = run(["chrome", "extension"]);
const extDir = ext.stdout.trim();
check("aiui chrome extension exits 0", ext.status === 0, ext.stderr);
check(
  "packed extension ships manifest + built js",
  !!extDir &&
    existsSync(join(extDir, "manifest.json")) &&
    existsSync(join(extDir, "js", "panel.js")),
  extDir || "(no path printed)",
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
check("status reports the devtools panel", /DevTools panel/.test(status.stdout));

const claude = run(["claude"]);
check("aiui claude without claude on PATH fails politely", claude.status === 1);
check("…with the PATH explanation", /not found on your PATH/.test(claude.stderr), claude.stderr);

const mcp = run(["mcp", "--help"]);
check("aiui mcp --help (channel CLI from dist) exits 0", mcp.status === 0, mcp.stderr);

// The installed sidecar path, end to end: resolve the code sidecar the way the
// CLI does (require.resolve against the exports map → an absolute dist path),
// then load + construct + mount it the way the channel does — under plain node,
// from the packed tarballs. This is the dev/installed seam that source-first
// masks: in the workspace this resolves to src/*.ts under tsx; installed it
// must resolve to dist/*.js and import cleanly with no loader.
const sidecarProbe = join(scratch, "sidecar-probe.mjs");
writeFileSync(
  sidecarProbe,
  `import { createRequire } from "node:module";
import { loadSidecars } from "@habemus-papadum/aiui-claude-channel";
const resolved = createRequire(import.meta.url).resolve(
  "@habemus-papadum/aiui-code-server/sidecar",
);
if (!resolved.endsWith(".js")) throw new Error("expected a dist .js path, got: " + resolved);
// The raw absolute path, exactly as aiui's resolveSidecars hands it over.
const sidecars = await loadSidecars([
  { name: "code", module: resolved, export: "codeReaderSidecar", options: { root: process.cwd() } },
]);
if (sidecars.length !== 1) throw new Error("the code sidecar did not load");
const express = (await import("express")).default;
const mounted = await sidecars[0].mount(express(), { log: () => {} });
await mounted.dispose?.();
console.log(resolved);
`,
);
const probe = spawnSync(process.execPath, [sidecarProbe], {
  cwd: scratch,
  env,
  encoding: "utf8",
  timeout: 60_000,
});
check(
  "code sidecar resolves to dist and mounts under plain node",
  probe.status === 0 && /dist[\\/]sidecar\.js\s*$/.test(probe.stdout),
  probe.stderr || probe.stdout,
);

// The demo scaffold proves the templates/ directory shipped in the tarball
// (a missing `files` entry is exactly this test's reason to exist).
const demo = run(["demo", "demo-sandbox", "--skip-install"]);
check("aiui demo scaffolds from the shipped template", demo.status === 0, demo.stderr);
check(
  "scaffold has the app and a restored .gitignore",
  existsSync(join(scratch, "demo-sandbox", "vite.config.ts")) &&
    existsSync(join(scratch, "demo-sandbox", "src", "main.ts")) &&
    existsSync(join(scratch, "demo-sandbox", ".gitignore")),
);
const demoAgain = run(["demo", "demo-sandbox", "--skip-install"]);
check(
  "re-running aiui demo continues instead of re-scaffolding",
  demoAgain.status === 0 && /continuing/.test(demoAgain.stderr + demoAgain.stdout),
  demoAgain.stderr,
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
