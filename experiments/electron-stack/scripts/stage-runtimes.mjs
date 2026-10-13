#!/usr/bin/env node
import { execFile } from "node:child_process";
// Host-native, independently executable runtimes. Electron is not the Node backend runtime.
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const vendor = path.join(root, "vendor");
const options = new Set(process.argv.slice(2));
for (const option of options) {
  if (!["--offline", "--check", "--help"].includes(option))
    throw new Error(`Unknown option: ${option}`);
}
if (options.has("--help")) {
  console.log(
    "Stage host-native Node and Python: node scripts/stage-runtimes.mjs [--offline | --check]\nCache: ELECTRON_RUNTIME_CACHE or ~/.cache/electron-stack/runtimes\n--offline uses cached metadata/archives; --check validates staged runtimes without downloading.",
  );
  process.exit(0);
}
const platform = process.platform;
const arch = process.arch;
if (!["darwin", "linux"].includes(platform) || !["arm64", "x64"].includes(arch)) {
  throw new Error(`Supported hosts: macOS/Linux arm64/x64; received ${platform}/${arch}`);
}
const cache =
  process.env.ELECTRON_RUNTIME_CACHE || path.join(homedir(), ".cache/electron-stack/runtimes");
const nodeVersion = "24.21.0";
const pythonRelease = "20261009";
const pythonTarget = `${arch === "arm64" ? "aarch64" : "x86_64"}-${platform === "darwin" ? "apple-darwin" : "unknown-linux-gnu"}`;

async function download(url, destination) {
  if (options.has("--offline")) throw new Error(`Offline cache miss: ${destination}`);
  console.log(`Downloading ${url}`);
  const response = await fetch(url, {
    headers: { "User-Agent": "electron-stack-runtime-spike" },
    signal: AbortSignal.timeout(180_000),
  });
  if (!response.ok || !response.body) throw new Error(`${response.status} downloading ${url}`);
  const temporary = `${destination}.${process.pid}.partial`;
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { flags: "wx" }));
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function cached(url, filename) {
  const destination = path.join(cache, filename);
  try {
    await readFile(destination);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await download(url, destination);
  }
  return destination;
}

async function sha256(filename) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
}

async function archive(source, filename, expected) {
  if (!/^[a-f0-9]{64}$/.test(expected)) throw new Error(`Missing SHA-256 for ${filename}`);
  const filenameOnDisk = await cached(source, filename);
  const actual = await sha256(filenameOnDisk);
  if (actual !== expected)
    throw new Error(`Checksum mismatch for ${filename}; remove ${filenameOnDisk} and retry`);
  return filenameOnDisk;
}

async function check(directory) {
  const manifest = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8"));
  if (manifest.platform !== platform || manifest.arch !== arch)
    throw new Error("Staged runtimes target another host architecture");
  // No PYTHONHOME, PYTHONPATH, NODE_OPTIONS, virtualenv or developer PATH inheritance.
  const env = { HOME: directory, PATH: "/usr/bin:/bin", LANG: "C.UTF-8" };
  const node = await run(
    path.join(directory, "node/bin/node"),
    [
      "-e",
      "console.log(JSON.stringify({version:process.version,arch:process.arch,platform:process.platform}))",
    ],
    { env },
  );
  const python = await run(
    path.join(directory, "python/bin/python3"),
    [
      "-I",
      "-c",
      "import json,sys,ssl,sqlite3,ctypes; print(json.dumps({'version':sys.version.split()[0],'prefix':sys.prefix,'ssl':ssl.OPENSSL_VERSION,'sqlite':sqlite3.sqlite_version}))",
    ],
    { env },
  );
  const nodeInfo = JSON.parse(node.stdout);
  const pythonInfo = JSON.parse(python.stdout);
  if (
    nodeInfo.version !== `v${manifest.node.version}` ||
    pythonInfo.version !== manifest.python.version
  )
    throw new Error("Runtime version does not match manifest");
  if (path.resolve(pythonInfo.prefix) !== path.join(directory, "python"))
    throw new Error(`Python used an unexpected installation: ${pythonInfo.prefix}`);
  console.log(
    `Validated Node ${nodeInfo.version}, Python ${pythonInfo.version}, ${pythonInfo.ssl}, SQLite ${pythonInfo.sqlite}`,
  );
}

if (options.has("--check")) {
  await check(vendor);
} else {
  await mkdir(cache, { recursive: true });
  const nodeName = `node-v${nodeVersion}-${platform}-${arch}.tar.gz`;
  const nodeBase = `https://nodejs.org/dist/v${nodeVersion}/`;
  const sums = await readFile(
    await cached(`${nodeBase}SHASUMS256.txt`, `node-v${nodeVersion}-SHASUMS256.txt`),
    "utf8",
  );
  const nodeHash = sums
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .find((entry) => entry[1] === nodeName)?.[0];
  const releaseUrl = `https://api.github.com/repos/astral-sh/python-build-standalone/releases/tags/${pythonRelease}`;
  const release = JSON.parse(
    await readFile(await cached(releaseUrl, `python-${pythonRelease}-release.json`), "utf8"),
  );
  const pythonAsset = release.assets.find(
    (asset) =>
      asset.name.startsWith("cpython-3.13.") &&
      asset.name.endsWith(`-${pythonTarget}-install_only_stripped.tar.gz`),
  );
  if (!pythonAsset?.digest?.startsWith("sha256:"))
    throw new Error("Pinned Python release lacks target or GitHub SHA-256 digest");
  const pythonHash = pythonAsset.digest.slice(7);
  const nodeSource = `${nodeBase}${nodeName}`;
  const pythonSource = pythonAsset.browser_download_url;
  const nodeArchive = await archive(nodeSource, nodeName, nodeHash);
  const pythonArchive = await archive(pythonSource, pythonAsset.name, pythonHash);
  const staging = await mkdtemp(path.join(root, ".runtime-stage-"));
  const original = path.join(staging, "original");
  const relocated = path.join(staging, "relocated");
  const backup = path.join(staging, "previous");
  try {
    await mkdir(path.join(original, "node"), { recursive: true });
    await mkdir(path.join(original, "python"), { recursive: true });
    await run("tar", [
      "-xzf",
      nodeArchive,
      "--strip-components=1",
      "-C",
      path.join(original, "node"),
    ]);
    await run("tar", [
      "-xzf",
      pythonArchive,
      "--strip-components=1",
      "-C",
      path.join(original, "python"),
    ]);
    const manifest = {
      platform,
      arch,
      node: {
        version: nodeVersion,
        source: nodeSource,
        sha256: nodeHash,
        checksumSource: `${nodeBase}SHASUMS256.txt`,
      },
      python: {
        version: pythonAsset.name.match(/^cpython-([^+]+)/)[1],
        release: pythonRelease,
        target: pythonTarget,
        source: pythonSource,
        sha256: pythonHash,
        checksumSource: releaseUrl,
      },
    };
    await writeFile(path.join(original, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    await rename(original, relocated);
    await check(relocated); // Prove runtime paths survive moving the installation tree.
    let hadPrevious = false;
    try {
      await rename(vendor, backup);
      hadPrevious = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    try {
      await rename(relocated, vendor);
    } catch (error) {
      if (hadPrevious) await rename(backup, vendor);
      throw error;
    }
    await check(vendor);
    console.log(`Staged self-contained runtimes in ${vendor}`);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
