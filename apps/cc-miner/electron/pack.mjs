/**
 * pack.mjs — build the installable artifacts.
 *
 *   node electron/pack.mjs mac      → release/*.dmg, release/*.zip, latest-mac.yml
 *   node electron/pack.mjs linux    → release/*.AppImage, release/*.deb, latest-linux.yml
 *   node electron/pack.mjs dir      → release/mac-arm64/cc-miner.app (fast, unpackaged)
 *
 * This wrapper exists for ONE reason worth stating plainly: two fields in
 * cc-miner's package.json are correct for a workspace member and wrong for a
 * desktop app, and neither may be edited in the tree.
 *
 *   main      `./src/index.ts` — the library barrel. Every sibling in this
 *             workspace consumes cc-miner source-first through it; a desktop
 *             build needs `electron/main.mjs` instead.
 *   version   `X.Y.Z+dev` — the workspace lockstep marker, owned exclusively by
 *             the release pipeline (AGENTS.md). It is also a semver TRAP:
 *             build metadata is ignored by semver comparison, so `0.12.0+dev`
 *             and `0.12.0` compare EQUAL and electron-updater would decide
 *             there is nothing newer. Forever.
 *
 * `extraMetadata` rewrites both in the package.json that goes INTO the bundle,
 * leaving the repo's own untouched. That is the whole trick, and it is why this
 * script exists rather than a line in a README telling someone to remember.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(HERE, "..");

/** @type {Record<string, string[]>} */
const TARGETS = { mac: ["--mac"], linux: ["--linux"], dir: ["--dir"] };
const target = process.argv[2] ?? "dir";
if (!(target in TARGETS)) {
  console.error(`usage: pack.mjs <${Object.keys(TARGETS).join("|")}>`);
  process.exit(2);
}

/**
 * The version the artifact carries.
 *
 * `CC_MINER_VERSION` when the release pipeline supplies one; otherwise a
 * PRERELEASE derived from the commit — `0.12.0-dev.a1b2c3d`, which semver sorts
 * strictly BELOW `0.12.0`. A local build can therefore never look newer than a
 * real release to an updater, which is the failure mode worth designing out.
 */
function appVersion() {
  if (process.env.CC_MINER_VERSION) return process.env.CC_MINER_VERSION.replace(/^v/, "");
  const pkg = JSON.parse(readFileSync(resolve(APP_ROOT, "package.json"), "utf8"));
  const base = String(pkg.version).replace(/\+.*$/, "");
  const sha = spawnSync("git", ["rev-parse", "--short=7", "HEAD"], { encoding: "utf8" });
  const suffix = sha.status === 0 ? sha.stdout.trim() : "local";
  return `${base}-dev.${suffix}`;
}

const version = appVersion();
console.log(`\n  cc-miner ${version} → ${target}\n`);

// The renderer first: the bundle's whole reason for existing is dist/, and
// packaging a stale one produces an artifact that looks fine and is not.
const build = spawnSync("npx", ["vite", "build"], { cwd: APP_ROOT, stdio: "inherit" });
if (build.status !== 0) process.exit(build.status ?? 1);

const args = [
  "electron-builder",
  ...TARGETS[target],
  "--config",
  "electron-builder.yml",
  `-c.extraMetadata.main=electron/main.mjs`,
  `-c.extraMetadata.version=${version}`,
  // Never publish as a side effect of building. Releasing is its own deliberate
  // act, and electron-builder's default of "publish if it detects CI" is
  // exactly the kind of implicit behaviour that ships something by accident.
  "--publish",
  "never",
  ...process.argv.slice(3),
];
const res = spawnSync("npx", args, { cwd: APP_ROOT, stdio: "inherit" });
process.exit(res.status ?? 1);
