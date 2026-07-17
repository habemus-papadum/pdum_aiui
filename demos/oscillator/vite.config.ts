import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { sourceLocatorVite } from "@habemus-papadum/aiui-source-processor";
import { defineConfig } from "vite";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

// Externalize Node builtins + everything this package declares as a runtime/peer
// dependency, so the library bundle never inlines a consumer-provided module.
const external = [
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.peerDependencies ?? {}),
];

export default defineConfig({
  // The aiui compiler in THIS package's own toolchain — the "library-grade
  // identity" story: the slice's control()/cell()/action() call sites get
  // their names, descriptions, and locs injected here, so the built dist (and
  // this package's own tests) carry identity without any consumer involvement.
  // `locPrefix` package-qualifies the locs ("@habemus-papadum/aiui-oscillator/
  // src/slice.ts:57") so they stay meaningful wherever they surface. In-repo
  // consumers (demos/twins) import the SOURCE and their own compiler injects
  // dotdot-relative locs instead — same identity, app-resolvable paths.
  plugins: [
    sourceLocatorVite({
      locPrefix: `${pkg.name}/`,
      stampJsx: false, // a headless slice ships no JSX; identity only
    }),
  ],
  build: {
    lib: {
      entry: "src/index.ts",
      formats: ["es"],
      fileName: "index",
    },
    outDir: "dist",
    sourcemap: true,
    emptyOutDir: false, // keep the tsc-emitted .d.ts (build runs tsc first)
    rollupOptions: {
      external: (id) => external.some((mod) => id === mod || id.startsWith(`${mod}/`)),
    },
  },
});
