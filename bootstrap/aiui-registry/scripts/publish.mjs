#!/usr/bin/env node
/**
 * Manual publish for @habemus-papadum/aiui-registry — the deliberate exception
 * to the repo's CI-only publishing rule (AGENTS.md; docs/proposals/aiui-registry.md §10).
 * Run LOCALLY with your own npm login; npm will prompt for 2FA (or pass
 * --otp <code> once for the whole run). The first real publish claims the
 * names — no separate reserve/trust step (manual publishing needs no OIDC).
 *
 *   node scripts/publish.mjs --dry-run          # gates + stage + pack, no publish
 *   node scripts/publish.mjs [--otp <code>]     # the real thing
 *
 * Order matters: the four platform packages go first, then the main package —
 * so the moment the main package is visible, its optionalDependencies resolve.
 */
import { execFileSync } from "node:child_process";
import { readManifest, root, stageMainPackage, stagePlatformPackage } from "./stage.mjs";
import { platformPackageName, TARGETS } from "./targets.mjs";

const argv = process.argv.slice(2);
let dryRun = false;
let otp;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--dry-run") {
    dryRun = true;
  } else if (argv[i] === "--otp") {
    otp = argv[++i];
  } else {
    console.error(`unknown argument: ${argv[i]}`);
    process.exit(2);
  }
}

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { cwd: root, stdio: "inherit", ...opts });
const capture = (cmd, args) =>
  execFileSync(cmd, args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const { version } = readManifest();
const names = [...Object.keys(TARGETS).map(platformPackageName), "@habemus-papadum/aiui-registry"];

// -- gates ------------------------------------------------------------------
if (!dryRun) {
  try {
    console.log(`npm user: ${capture("npm", ["whoami"]).trim()}`);
  } catch {
    console.error("not logged in to npm — run `npm login` first");
    process.exit(1);
  }
}
for (const name of names) {
  let published = "";
  try {
    published = capture("npm", ["view", `${name}@${version}`, "version"]).trim();
  } catch {
    // E404 — not published; exactly what we want.
  }
  if (published) {
    console.error(`${name}@${version} is already on the registry — bump the version first`);
    process.exit(1);
  }
}

// -- build + verify ---------------------------------------------------------
console.log("\n== gates: typecheck, test, build, binaries (all targets) ==");
run("pnpm", ["typecheck"]);
run("pnpm", ["test"]);
run("pnpm", ["build"]);
run("pnpm", ["binaries"]);

// -- stage ------------------------------------------------------------------
console.log("\n== staging dist-publish/ ==");
const dirs = Object.keys(TARGETS).map((key) => stagePlatformPackage(key, version));
dirs.push(stageMainPackage());
for (const dir of dirs) {
  console.log(`staged ${dir}`);
}

// -- publish (platforms first, then main) -----------------------------------
console.log(dryRun ? "\n== npm publish --dry-run ==" : "\n== npm publish ==");
for (const dir of dirs) {
  run("npm", [
    "publish",
    dir,
    "--access",
    "public",
    ...(dryRun ? ["--dry-run"] : []),
    ...(otp ? ["--otp", otp] : []),
  ]);
}
console.log(
  dryRun
    ? `\ndry run complete — ${names.length} packages would publish at ${version}`
    : `\npublished ${names.length} packages at ${version}`,
);
