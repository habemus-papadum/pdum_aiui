import { execFileSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// Explicit manual upload, never part of dev/build/test. Requires an existing bucket.
const [bucket, prefix = "site"] = process.argv.slice(2);
if (!bucket) throw new Error("Usage: node deploy/upload-r2.mjs <bucket> [release-prefix]");
const root = fileURLToPath(new URL("../", import.meta.url));
const dist = join(root, "dist");
const wrangler = join(root, "node_modules/wrangler/bin/wrangler.js");
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
};
async function upload(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) await upload(file);
    else {
      const key = `${prefix.replace(/\/$/, "")}/${relative(dist, file).split("\\").join("/")}`;
      console.log(`Uploading ${key}`);
      execFileSync(
        process.execPath,
        [
          wrangler,
          "r2",
          "object",
          "put",
          `${bucket}/${key}`,
          "--file",
          file,
          "--remote",
          "--content-type",
          types[extname(file)] ?? "application/octet-stream",
          "--cache-control",
          key.includes("/assets/")
            ? "public, max-age=31536000, immutable"
            : "public, max-age=0, must-revalidate",
        ],
        { cwd: root, stdio: "inherit" },
      );
    }
  }
}
await upload(dist);
