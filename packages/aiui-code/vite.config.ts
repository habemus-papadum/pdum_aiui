import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";
import aiuiDevOverlay from "@habemus-papadum/aiui-dev-overlay/vite";
import { defineConfig, type Plugin } from "vite";
import solid from "vite-plugin-solid";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

// Externalize Node builtins + everything this package declares as a runtime/peer
// dependency, so the library bundle never inlines a consumer-provided module
// (monaco-editor, solid-js, @solidjs/web, aiui-viz all stay external).
const external = [
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.peerDependencies ?? {}),
];

// AIUI_CODE_ROOT picks the project the standalone harness reads + runs the LSP
// against; it defaults to the bundled Python demo so `pnpm dev` works with zero
// setup.
const defaultRoot = fileURLToPath(new URL("../../examples/py-demo", import.meta.url));
const projectRoot = process.env.AIUI_CODE_ROOT ?? defaultRoot;

// Mount the reader's backend (the sibling `@habemus-papadum/aiui-code-server`
// package) on THIS dev server. It is loaded at `configureServer` time through
// Vite's SSR pipeline — NOT a top-level `import`: Vite's esbuild config-file
// bundler would externalize the sibling package and hand its (transitively,
// aiui-code-protocol's) extensionless workspace TS to plain Node, which can't
// resolve it. SSR transpiles workspace source the same way the app build does.
function readerBackendPlugin(root: string): Plugin {
  return {
    name: "aiui-code-harness-backend",
    async configureServer(server) {
      const { aiuiCodeBackendPlugin } = (await server.ssrLoadModule(
        "@habemus-papadum/aiui-code-server/vite",
      )) as typeof import("@habemus-papadum/aiui-code-server/vite");
      const mount = aiuiCodeBackendPlugin({ root }).configureServer;
      if (typeof mount === "function") {
        await mount.call(server, server);
      }
    },
  };
}

export default defineConfig(({ command }) => {
  // `vite build` → the publishable library (dist/index.js). In-repo consumers
  // (the dev overlay) bundle our SOURCE via the editable-deps convention; this
  // dist is only for standalone external consumers.
  if (command === "build") {
    return {
      plugins: [solid()],
      build: {
        lib: { entry: "src/index.ts", formats: ["es"], fileName: "index" },
        outDir: "dist",
        sourcemap: true,
        emptyOutDir: false, // keep the tsc-emitted .d.ts (build runs tsc first)
        rollupOptions: {
          external: (id) => external.some((mod) => id === mod || id.startsWith(`${mod}/`)),
        },
      },
    };
  }

  // `vite` (dev) → the standalone reader harness: the reader UI + its backend on
  // one dev server, no channel. The reader is session-agnostic now (the session
  // UI lives in the overlay), so the harness just needs the backend + the
  // compile-time source-locator. main.tsx pins the backend to this origin.
  return {
    plugins: [
      readerBackendPlugin(projectRoot),
      aiuiDevOverlay({
        locator: { cellFactories: ["cell"] },
        session: false,
        intentTool: false,
      }),
      solid(),
    ],
    server: {
      fs: {
        // Let the dev server read the workspace root (the reader imports from
        // sibling workspace packages via source-first exports).
        allow: [fileURLToPath(new URL("../..", import.meta.url))],
      },
    },
    // monaco-editor ships a big ESM tree; let Vite prebundle it (it is NOT a
    // workspace package, so this is safe — the stale-cache hazard in CLAUDE.md is
    // specific to workspace-linked deps).
    optimizeDeps: {
      include: ["monaco-editor"],
    },
  };
});
