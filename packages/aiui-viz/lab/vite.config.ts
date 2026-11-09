import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { aiui } from "@habemus-papadum/aiui-source-processor";
import { defineConfig, type Plugin } from "vite";
import solid from "vite-plugin-solid";
import { PAGES } from "./src/ui/routes";

/** The S3 website endpoint has no SPA fallback, so each page needs a document
 * of its own: /aiui/lab/training redirects to /aiui/lab/training/, which serves
 * that folder's index.html. Real files, so `aws s3 sync` needs no special case. */
function deepLinks(): Plugin {
  let outDir = "";
  return {
    name: "viz-lab:deep-links",
    apply: "build",
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      const html = readFileSync(join(outDir, "index.html"));
      for (const { id } of PAGES) {
        mkdirSync(join(outDir, id), { recursive: true });
        writeFileSync(join(outDir, id, "index.html"), html);
      }
    },
  };
}

/** The aiui-viz lab — `pnpm -C packages/aiui-viz lab`. One document, routed
 * on the pathname (Vite's SPA fallback serves index.html for every page).
 * The gallery's publish.sh builds it into the site at /aiui/lab/; the build
 * ships its sources and links stamps to GitHub, as the gallery's does. */
export default defineConfig(({ command, isPreview }) => ({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: command === "build" || isPreview ? "/aiui/lab/" : "/",
  plugins: [
    aiui({
      locator: true,
      ...(command === "build"
        ? {
            sources: "ship" as const,
            sourceRoot:
              "https://github.com/habemus-papadum/pdum_aiui/blob/main/packages/aiui-viz/lab/",
          }
        : {}),
    }),
    solid(),
    deepLinks(),
  ],
}));
