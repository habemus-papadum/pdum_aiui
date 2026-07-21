/**
 * `aiui vscode install` — install the aiui VS Code extension from this repo's
 * GitHub release page.
 *
 * The extension is built and attached to every release as a fixed-name asset
 * (`aiui-vscode.vsix`) by `release.yml`; it is NOT on the VS Code Marketplace
 * and NOT bundled into the npm package. So installing it is: derive the release
 * tag from this aiui build's version (`v<X.Y.Z>`, the same `v`-prefixed tag
 * `scripts/versioning.mjs` cuts), download the asset, and hand it to
 * `code --install-extension`.
 *
 * Deliberately mode-agnostic: it always pulls the published .vsix rather than
 * branching on source-vs-installed. In a source checkout the derived tag is the
 * LAST release (the working tree's `X.Y.Z+dev` has no release of its own) — if
 * you want the extension matching an unreleased tree, build+install it locally
 * with `pnpm -C packages/aiui-vscode run install:vsix` instead. This command is
 * for the common installed case, and it keeps aiui free of any runtime
 * dependency on aiui-vscode / vsce.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { printError, printNote } from "../util/ui";
import { VERSION } from "../util/version";

/** `owner/repo` the releases live under. Hardcoded like INTENT_CLIENT_EXTENSION_ID. */
export const REPO_SLUG = "habemus-papadum/pdum_aiui";

/** The fixed release-asset name (see packages/aiui-vscode/build-extension.mjs). */
export const VSIX_ASSET = "aiui-vscode.vsix";

export interface VscodeOptions {
  /** The editor CLI to install into. Default `code`. */
  editor?: string;
  /** Override the release to pull from: `latest` or a tag like `v0.7.0`. */
  tag?: string;
}

/**
 * The release tag for this aiui build: strip any build/prerelease suffix
 * (`0.7.0+dev` → `0.7.0`) and `v`-prefix it, matching versioning.mjs's tags.
 */
export function releaseTagForVersion(version: string): string {
  const core = version.replace(/[+-].*$/, "");
  return `v${core}`;
}

/**
 * Normalize a user-supplied `--tag`: pass `latest` through, `v`-prefix a bare
 * `X.Y.Z`, and leave an already-`v`-prefixed tag alone.
 */
export function normalizeTag(tag: string): string {
  if (tag === "latest") {
    return tag;
  }
  return /^\d/.test(tag) ? `v${tag}` : tag;
}

/** The GitHub download URL for the .vsix at a given tag (or `latest`). */
export function vsixDownloadUrl(tag: string): string {
  const base = `https://github.com/${REPO_SLUG}/releases`;
  return tag === "latest"
    ? `${base}/latest/download/${VSIX_ASSET}`
    : `${base}/download/${tag}/${VSIX_ASSET}`;
}

export async function runVscode(action: string, options: VscodeOptions = {}): Promise<void> {
  if (action !== "install") {
    throw new Error(`aiui vscode: unknown action "${action}" (install)`);
  }

  const editor = options.editor ?? "code";
  const tag = options.tag ? normalizeTag(options.tag) : releaseTagForVersion(VERSION);
  const url = vsixDownloadUrl(tag);

  printNote(`Downloading the aiui VS Code extension (${tag})`, url);

  let bytes: Uint8Array;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      const hint =
        res.status === 404
          ? `No ${VSIX_ASSET} at ${tag}. Try \`aiui vscode install --tag latest\`, ` +
            "or check the releases page."
          : `The download failed (HTTP ${res.status}).`;
      printError(`Could not fetch ${VSIX_ASSET} for ${tag}`, hint);
      process.exitCode = 1;
      return;
    }
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch (error) {
    printError(
      "Could not reach GitHub to download the extension",
      error instanceof Error ? error.message : String(error),
    );
    process.exitCode = 1;
    return;
  }

  const file = join(mkdtempSync(join(tmpdir(), "aiui-vscode-")), VSIX_ASSET);
  writeFileSync(file, bytes);

  const installed = spawnSync(editor, ["--install-extension", file], { stdio: "inherit" });
  if (installed.error) {
    const code =
      "code" in (installed.error as NodeJS.ErrnoException) &&
      (installed.error as NodeJS.ErrnoException).code === "ENOENT";
    printError(
      `Could not run \`${editor}\``,
      code
        ? `Is the VS Code CLI on your PATH? ` +
            "(VS Code: ⇧⌘P → \"Shell Command: Install 'code' command in PATH\".) " +
            `Or pass a different editor with \`--editor <bin>\` (e.g. code-insiders, cursor).`
        : installed.error.message,
    );
    process.exitCode = 1;
    return;
  }
  if (installed.status !== 0) {
    process.exitCode = installed.status ?? 1;
    return;
  }
  printNote("Installed — reload the VS Code window to activate it.");
}
