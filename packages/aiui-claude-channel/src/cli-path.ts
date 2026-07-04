import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Absolute path to this package's built CLI entry (`dist/cli.js`).
 *
 * Resolved from the package root (the nearest ancestor directory that has a
 * `package.json`), so it is correct whether the package is installed from npm
 * or built locally. This lets a consumer wire the channel into an MCP config by
 * absolute path — spawned as `node <path> mcp` — rather than relying on the
 * `aiui-claude-channel` bin being on the PATH.
 */
export function channelCliPath(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  let parent = dirname(dir);
  while (dir !== parent) {
    if (existsSync(resolve(dir, "package.json"))) {
      return resolve(dir, "dist", "cli.js");
    }
    dir = parent;
    parent = dirname(dir);
  }
  throw new Error("could not locate the aiui-claude-channel package root");
}
