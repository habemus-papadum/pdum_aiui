// End-to-end proof of the starter template's contract. CI runs this as its own
// job; locally: `pnpm test:template`.
//
// The template's example tests (rose.test.ts, scenery.test.ts) deliberately do
// NOT run under any package's own vitest project — they need the template's
// vitest.config.ts (jsdom + the Solid resolution story), which only exists in a
// scaffolded app. CI still typechecks them (create-aiui's tsconfig.template),
// but a runtime regression would otherwise surface at scaffold time, in a
// user's first `npm test`. This script closes that gap by exercising the whole
// lifecycle the docs promise:
//
//   1. scaffold a throwaway in-repo demo (`pnpm new-demo`, the real path);
//   2. the sceneried app: its tests pass (and really ran — the count is
//      asserted, since passWithNoTests would otherwise mask a collection bug)
//      and it typechecks;
//   3. apply the mechanical reset EXACTLY as the template CLAUDE.md documents
//      it — dumb line rules under src/, no code reasoning — guarding the fence
//      grammar itself (unclosed fences fail here, not in a user's sandbox);
//   4. the blank app: typechecks, tests green (no tests), `vite build` works.
//
// The probe joins the workspace temporarily (new-demo scaffolds into demos/),
// so the lockfile is snapshotted and restored, and the demo removed, whatever
// happens.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SLUG = "template-e2e-probe";
const probeDir = join(repoRoot, "demos", SLUG);
const lockfilePath = join(repoRoot, "pnpm-lock.yaml");

/**
 * Drop ANSI colour codes from captured output. The checks below MATCH on this
 * text, and vitest colourises whenever `$CI` is set — so `Test Files  2 passed`
 * arrives as `\e[2m Test Files \e[22m \e[1m\e[32m2 passed\e[39m`, where a
 * `Test Files\s+2 passed` regex finds escape codes, not whitespace, and fails.
 * Piping locally turns colour off, so this could only ever break in CI (it did).
 * Built with `new RegExp` rather than a literal: an ESC in a regex literal is a
 * control character Biome (rightly) flags.
 */
const ANSI_SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const stripAnsi = (text: string): string => text.replace(ANSI_SGR, "");

function run(command: string, args: string[], cwd = repoRoot): string {
  process.stdout.write(`\n$ ${command} ${args.join(" ")}\n`);
  return stripAnsi(
    execFileSync(command, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    }),
  );
}

function check(label: string, ok: boolean, detail = ""): void {
  if (!ok) {
    process.stderr.write(`  ✗ ${label}\n${detail}\n`);
    process.exitCode = 1;
    throw new Error(label);
  }
  process.stdout.write(`  ✓ ${label}\n`);
}

/**
 * The reset from the template's CLAUDE.md § "Reset to a blank canvas",
 * implemented as dumbly as it is documented — line rules only:
 *   1. under src/, delete files whose FIRST line contains <aiui-scenery-file>;
 *   2. in remaining src/ files, delete each block from a line containing
 *      <aiui-scenery> through the next line containing </aiui-scenery>,
 *      inclusive of both marker lines.
 */
function mechanicalReset(srcDir: string): { deleted: number; edited: number } {
  let deleted = 0;
  let edited = 0;
  const walk = (dir: string): string[] =>
    execFileSync("find", [dir, "-type", "f"], { encoding: "utf8" }).trim().split("\n");
  for (const file of walk(srcDir)) {
    const lines = readFileSync(file, "utf8").split("\n");
    if (lines[0]?.includes("<aiui-scenery-file>")) {
      rmSync(file);
      deleted++;
      continue;
    }
    const out: string[] = [];
    let skipping = false;
    let changed = false;
    for (const line of lines) {
      if (!skipping && line.includes("<aiui-scenery>")) {
        skipping = true;
        changed = true;
        continue;
      }
      if (skipping) {
        if (line.includes("</aiui-scenery>")) skipping = false;
        continue;
      }
      out.push(line);
    }
    if (skipping) {
      throw new Error(`unclosed <aiui-scenery> fence in ${relative(repoRoot, file)}`);
    }
    if (changed) {
      writeFileSync(file, out.join("\n"));
      edited++;
    }
  }
  return { deleted, edited };
}

const lockfileBefore = readFileSync(lockfilePath, "utf8");
rmSync(probeDir, { recursive: true, force: true }); // a crashed prior run

try {
  run("pnpm", ["new-demo", SLUG]);
  run("pnpm", ["install", "--no-frozen-lockfile"]);

  // -- the sceneried app -------------------------------------------------------
  const sceneried = run("pnpm", ["-C", probeDir, "test"]);
  check(
    "sceneried scaffold: example tests ran and passed (2 files)",
    /Test Files\s+2 passed/.test(sceneried),
    sceneried.slice(-800),
  );
  run("pnpm", ["-C", probeDir, "typecheck"]);
  check("sceneried scaffold: typechecks", true);

  // -- the documented reset -----------------------------------------------------
  const { deleted, edited } = mechanicalReset(join(probeDir, "src"));
  check(
    `mechanical reset per CLAUDE.md: ${deleted} scenery files deleted, ${edited} files fence-edited`,
    deleted >= 5 && edited >= 4,
  );

  // -- the blank app -----------------------------------------------------------
  run("pnpm", ["-C", probeDir, "typecheck"]);
  check("blank app: typechecks", true);
  const blank = run("pnpm", ["-C", probeDir, "test"]);
  check("blank app: `test` stays green with no tests", true, blank.slice(-400));
  run("pnpm", ["-C", probeDir, "exec", "vite", "build"]);
  check("blank app: production `vite build` succeeds", true);

  process.stdout.write("\ntemplate e2e: all checks passed\n");
} finally {
  rmSync(probeDir, { recursive: true, force: true });
  writeFileSync(lockfilePath, lockfileBefore);
  // Re-sync node_modules to the restored lockfile so a local run leaves the
  // checkout exactly as found (fast: everything is already in the store).
  run("pnpm", ["install"]);
  if (existsSync(probeDir)) {
    // Don't throw from finally (it would mask the original failure) — flag it.
    process.stderr.write("  ✗ probe demo survived cleanup\n");
    process.exitCode = 1;
  }
}
