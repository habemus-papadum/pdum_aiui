import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { paths } from "../src/storage.ts";

export const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const exec = promisify(execFile);
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

export async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "aibr-test-"));
  const p = paths({ AIBR_HOME: root });
  const bin = join(root, "bin");
  await mkdir(bin);
  const browser = join(bin, "browser");
  await writeFile(
    browser,
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(fileURLToPath(new URL("./fake-browser.mjs", import.meta.url)))} "$@"\n`,
    { mode: 0o755 },
  );
  const agent = join(root, "agent.mjs");
  // The SIGINT handler is installed before the pid line is written: the signal test sends
  // SIGINT the moment it reads that line, and a handler installed after the write loses the
  // race to the default disposition on a slow runner (seen twice on macOS CI, exit code null).
  await writeFile(
    agent,
    [
      "const wait = Boolean(process.env.AIBR_TEST_WAIT);",
      "if (wait) process.on('SIGINT', () => process.exit(17));",
      "console.log(JSON.stringify({pid:process.pid,args:process.argv.slice(2),cwd:process.cwd()}));",
      "if (wait) setInterval(() => {}, 1000);",
      "else process.exit(Number(process.env.AIBR_TEST_EXIT || 0));",
      "",
    ].join("\n"),
  );
  for (const name of ["claude", "codex"])
    await writeFile(
      join(bin, name),
      `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(agent)} "$@"\n`,
      { mode: 0o755 },
    );
  const env = {
    ...process.env,
    AIBR_HOME: root,
    PATH: [bin, dirname(process.execPath), process.env.PATH].join(delimiter),
  };
  return {
    root,
    p,
    browser,
    env,
    run: (args: string[]) =>
      exec(process.execPath, [cli, ...args], { env, cwd: root, timeout: 15_000 }),
    spawn: (args: string[], extraEnv: NodeJS.ProcessEnv = {}) =>
      spawn(process.execPath, [cli, ...args], {
        env: { ...env, ...extraEnv },
        cwd: root,
        stdio: ["pipe", "pipe", "pipe"],
      }),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
