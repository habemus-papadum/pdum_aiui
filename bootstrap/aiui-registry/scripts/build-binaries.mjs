#!/usr/bin/env node
/**
 * Compile the native-messaging host into self-contained binaries via bun
 * (a devDependency, so no global install needed). One binary per platform
 * target; the publish pipeline wraps each in its own npm platform package.
 *
 *   node scripts/build-binaries.mjs                 # all targets
 *   node scripts/build-binaries.mjs --target linux-x64 [--target …]
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { binaryName, TARGETS } from "./targets.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const requested = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--target") {
    requested.push(argv[++i]);
  } else {
    console.error(`unknown argument: ${argv[i]}`);
    process.exit(2);
  }
}
const keys = requested.length ? requested : Object.keys(TARGETS);
for (const key of keys) {
  if (!TARGETS[key]) {
    console.error(`unknown target ${key} (know: ${Object.keys(TARGETS).join(", ")})`);
    process.exit(2);
  }
}

const bun = join(root, "node_modules", ".bin", "bun");
if (!existsSync(bun)) {
  console.error("bun not found in node_modules/.bin — run `pnpm install` first");
  process.exit(1);
}

mkdirSync(join(root, "dist-bin"), { recursive: true });
for (const key of keys) {
  const outfile = join(root, "dist-bin", binaryName(key));
  console.log(`building ${outfile}`);
  execFileSync(
    bun,
    [
      "build",
      "--compile",
      `--target=${TARGETS[key].bun}`,
      join(root, "src", "host-main.ts"),
      "--outfile",
      outfile,
    ],
    { cwd: root, stdio: "inherit" },
  );
}
console.log(`done (${keys.length} target${keys.length === 1 ? "" : "s"})`);
