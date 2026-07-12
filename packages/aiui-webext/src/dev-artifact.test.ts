/**
 * The dev artifact's completeness guard. Its job is to make "the extension was
 * written into two directories" (or any other way an artifact can come out
 * unbootable) impossible to ship silently: the stamp is only written when every
 * file the manifest names is actually there.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { missingManifestFiles } from "./dev-artifact";

/** A dev-shaped artifact: loader stubs + CRXJS loading page, no entry bundles. */
function artifact(files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "aiui-webext-"));
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      manifest_version: 3,
      background: { service_worker: "service-worker-loader.js" },
      side_panel: { default_path: "src/panel/index.html" },
      icons: { 16: "icons/icon16.png" },
      content_scripts: [{ js: ["src/content.ts-loader.js"], matches: ["<all_urls>"] }],
      // Globs name no single file — the guard must not chase them.
      web_accessible_resources: [{ resources: ["**/*", "*"], matches: ["<all_urls>"] }],
    }),
  );
  for (const file of files) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), "");
  }
  return dir;
}

const complete = [
  "service-worker-loader.js",
  "src/panel/index.html",
  "src/content.ts-loader.js",
  "icons/icon16.png",
];

describe("missingManifestFiles", () => {
  it("passes a complete dev artifact — loader stubs, no entry bundles", () => {
    expect(missingManifestFiles(artifact(complete))).toEqual([]);
  });

  it("names exactly what a split artifact left behind", () => {
    // The failure this exists for: the bundles landed in the OTHER directory.
    const dir = artifact(complete.filter((f) => f !== "src/content.ts-loader.js"));
    expect(missingManifestFiles(dir)).toEqual(["src/content.ts-loader.js"]);
  });

  it("reports a missing manifest as the one thing wrong", () => {
    expect(missingManifestFiles(mkdtempSync(join(tmpdir(), "aiui-webext-")))).toEqual([
      "manifest.json",
    ]);
  });
});
