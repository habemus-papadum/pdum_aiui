import { type Plugin, parseSync, transformWithOxc } from "vite";
import { instrumentPromptSource } from "./instrument.ts";

/** Pass to Solid's `exclude` as well as any other JSX compiler in a mixed app. */
export const promptFilePattern = /\.prompt\.tsx(?:\?.*)?$/;

const importSource = "@habemus-papadum/aiui-prompts";

export interface PromptViteOptions {
  /** Record revision-qualified owner spans for JSX construction and interpolation. */
  sourceLocations?: boolean;
  /** Source paths are relative to this directory; defaults to Vite's resolved root. */
  sourceRoot?: string;
}

/**
 * Route `.prompt.tsx` through the toolkit's own automatic JSX runtime.
 *
 * ```ts
 * plugins: [aiui(), prompts(), solid({ exclude: promptFilePattern })]
 * ```
 *
 * Files should also begin with
 * `/** @jsxImportSource @habemus-papadum/aiui-prompts *\/` so the editor and
 * TypeScript use the same dialect as Vite. Ordinary `.tsx` stays with Solid.
 * This transform does not evaluate prompts or inspect session state.
 */
export function prompts(options: PromptViteOptions = {}): Plugin {
  let root = options.sourceRoot ?? process.cwd();
  return {
    name: "aiui-prompts:tsx",
    enforce: "pre",
    configResolved(config) {
      root = options.sourceRoot ?? config.root;
    },
    async transform(code, id) {
      if (!promptFilePattern.test(id)) return null;
      const [file, query] = id.split("?", 2);
      const params = new URLSearchParams(query);
      // These are asset imports, not modules of the prompt language.
      if (params.has("raw") || params.has("url")) return null;
      // Source pragmas take precedence over transform options in Oxc. Reject
      // a conflicting dialect instead of silently emitting a different runtime.
      // Read parsed comments so examples of pragmas inside prompt text are safe.
      for (const comment of parseSync(file, code).comments) {
        for (const pragma of comment.value.matchAll(/@(jsxImportSource|jsxRuntime)\s+(\S+)/g)) {
          const expected = pragma[1] === "jsxImportSource" ? importSource : "automatic";
          if (pragma[2] !== expected) {
            throw new Error(`${file}: prompt JSX requires @${pragma[1]} ${expected}`);
          }
        }
      }
      const instrumented = options.sourceLocations
        ? instrumentPromptSource(code, file, root)
        : undefined;
      return transformWithOxc(
        instrumented?.code ?? code,
        file,
        {
          lang: "tsx",
          jsx: { runtime: "automatic", importSource },
          sourcemap: true,
        },
        instrumented?.map,
      );
    },
  };
}

export default prompts;
