#!/usr/bin/env node
/**
 * Installed-shape test: prove the PUBLISHED form works before anything is
 * published. Stages the main + current-platform packages exactly as
 * publish.mjs would, packs them to tarballs, installs them into a scratch
 * project with npm, resolves the host binary THROUGH the installed package
 * (resolveHostBinary), and runs the framed-stdio smoke test against it.
 *
 * `--omit=optional` keeps npm from chasing the other three platform packages
 * (not on the registry yet / never matching this machine); the platform
 * package under test is installed explicitly instead.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readManifest, root, stageMainPackage, stagePlatformPackage } from "./stage.mjs";
import { currentTargetKey } from "./targets.mjs";

const key = currentTargetKey();
if (!key) {
  console.error(`unsupported platform ${process.platform}-${process.arch}`);
  process.exit(1);
}

const { version } = readManifest();
console.log(`== staging (main + ${key}) ==`);
const platformDir = stagePlatformPackage(key, version);
const mainDir = stageMainPackage();

console.log("== packing ==");
const pack = (dir) =>
  join(
    dir,
    JSON.parse(
      execFileSync("npm", ["pack", "--json"], {
        cwd: dir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
      }),
    )[0].filename,
  );
const tarballs = [pack(platformDir), pack(mainDir)];

const scratch = mkdtempSync(join(tmpdir(), "aiui-registry-install-"));
try {
  console.log(`== npm install (scratch: ${scratch}) ==`);
  writeFileSync(join(scratch, "package.json"), JSON.stringify({ private: true }));
  execFileSync("npm", ["install", "--omit=optional", "--no-audit", "--no-fund", ...tarballs], {
    cwd: scratch,
    stdio: "inherit",
  });

  console.log("== resolving the host binary through the installed package ==");
  const probe = `
    import { resolveHostBinary, PROTOCOL } from "@habemus-papadum/aiui-registry";
    const path = resolveHostBinary();
    if (!path) { console.error("resolveHostBinary returned undefined"); process.exit(1); }
    console.log(JSON.stringify({ path, protocol: PROTOCOL }));
  `;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", probe], {
    cwd: scratch,
    encoding: "utf8",
  });
  const { path: binary, protocol } = JSON.parse(out.trim());
  console.log(`resolved: ${binary} (protocol ${protocol})`);
  if (!existsSync(binary)) {
    console.error("resolved path does not exist");
    process.exit(1);
  }

  console.log("== smoke test against the INSTALLED binary ==");
  execFileSync(process.execPath, [join(root, "scripts", "smoke-host.mjs"), binary], {
    cwd: root,
    stdio: "inherit",
  });
  console.log("\ninstalled-shape test passed");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
