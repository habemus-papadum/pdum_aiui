import { readFileSync } from "node:fs";
import { externalizeDeps } from "@habemus-papadum/aiui-build-config";
import { defineConfig } from "vite";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

// The release line of every aiui package the template depends on, read from
// its workspace manifest beside this one. Between releases a manifest says
// `X.Y.Z+dev`, X.Y.Z being that package's last release; the scaffolder pins
// `^X.Y.Z`. Packages release independently (ship), so each line is its own.
const template = JSON.parse(
  readFileSync(new URL("./templates/app/package.json", import.meta.url), "utf8"),
);
const dependencyVersions: Record<string, string> = {};
for (const [name, range] of Object.entries<string>({
  ...template.dependencies,
  ...template.devDependencies,
})) {
  if (range !== "__AIUI_VERSION_RANGE__") continue;
  const sibling = JSON.parse(
    readFileSync(new URL(`../${name.split("/")[1]}/package.json`, import.meta.url), "utf8"),
  );
  dependencyVersions[name] = sibling.version;
}

export default defineConfig({
  define: {
    // Bake the versions into the CLI so the scaffolder can pin each aiui
    // dependency's range without a runtime package.json read.
    __CREATE_AIUI_VERSION__: JSON.stringify(pkg.version),
    __AIUI_DEPENDENCY_VERSIONS__: JSON.stringify(dependencyVersions),
  },
  build: {
    lib: {
      // Two entrypoints: the library (index) and the `create-aiui` bin (cli).
      entry: { index: "src/index.ts", cli: "src/cli.ts" },
      formats: ["es"],
      fileName: (_format, entryName) => `${entryName}.js`,
    },
    outDir: "dist",
    sourcemap: true,
    emptyOutDir: false, // keep the tsc-emitted .d.ts (build runs tsc first)
    rollupOptions: {
      external: externalizeDeps(pkg),
      output: {
        // Make only the CLI chunk directly executable; the library stays clean.
        banner: (chunk: { name: string }) => (chunk.name === "cli" ? "#!/usr/bin/env node" : ""),
      },
    },
  },
});
