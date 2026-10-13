#!/usr/bin/env node
import { spawn } from "node:child_process";
import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const destination = path.join(root, "vendor", "express");
const manifest = JSON.parse(await readFile(path.join(root, "vendor", "manifest.json"), "utf8"));
if (manifest.platform !== process.platform || manifest.arch !== process.arch) {
  throw new Error("Staged runtime architecture differs from this host; run npm run runtimes first");
}
for (const filename of [
  "out/main/index.cjs",
  "out/preload/index.cjs",
  "out/renderer/index.html",
  "vendor/node/bin/node",
  "vendor/python/bin/python3",
]) {
  await stat(path.join(root, filename));
}
await mkdir(destination, { recursive: true });
// Copy the lockfile verbatim: this gives the independent Node backend the same
// Express dependency versions as development, without including Electron/Vite.
await copyFile(path.join(root, "package.json"), path.join(destination, "package.json"));
await copyFile(path.join(root, "package-lock.json"), path.join(destination, "package-lock.json"));
const child = spawn("npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], {
  cwd: destination,
  stdio: "inherit",
  shell: false,
});
await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) =>
    code === 0
      ? resolve()
      : reject(new Error(`Backend dependency staging failed: ${signal ?? code}`)),
  );
});
console.log(
  `Prepared independent Express dependencies and ${manifest.platform}/${manifest.arch} runtimes`,
);
