import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// A relocation/runtime check. Gatekeeper acceptance still needs a downloaded
// artifact opened through Finder on a fresh recipient Mac.
if (process.platform !== "darwin") throw new Error("DMG checks require macOS");
const root = fileURLToPath(new URL("../", import.meta.url));
const candidates = (await readdir(join(root, "artifacts"))).filter((name) => name.endsWith(".dmg"));
if (!process.argv[2] && candidates.length !== 1)
  throw new Error("Provide the DMG path when artifacts/ contains zero or multiple images");
const dmg = process.argv[2] ? resolve(process.argv[2]) : join(root, "artifacts", candidates[0]);
const state = await mkdtemp(join(tmpdir(), "electron-dmg-test-"));
const mount = join(state, "mount");
const installed = join(state, "installed", "Electron Stack Spike.app");
let mounted = false;
function run(command, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} failed (${signal ?? code})`));
    });
  });
}
try {
  await mkdir(mount);
  await mkdir(join(state, "installed"));
  await run("/usr/bin/hdiutil", ["attach", dmg, "-readonly", "-nobrowse", "-mountpoint", mount]);
  mounted = true;
  await run("/usr/bin/ditto", [join(mount, "Electron Stack Spike.app"), installed]);
  await run("/usr/bin/hdiutil", ["detach", mount]);
  mounted = false;
  await run(process.execPath, ["--import", "tsx", "--test", "test/packaged.smoke.ts"], {
    ...process.env,
    PACKAGED_EXECUTABLE: join(installed, "Contents/MacOS/Electron Stack Spike"),
  });
} finally {
  // Never remove a directory while it is still an attached volume.
  if (mounted) await run("/usr/bin/hdiutil", ["detach", mount]);
  await rm(state, { recursive: true, force: true });
}
