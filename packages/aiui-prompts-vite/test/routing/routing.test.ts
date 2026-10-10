import { fileURLToPath } from "node:url";
import aiui from "@habemus-papadum/aiui-source-processor";
import { build, createServer, type Plugin } from "vite";
import solid from "vite-plugin-solid";
import { describe, expect, it } from "vitest";
import { promptFilePattern, prompts } from "../../src/index.ts";

const root = fileURLToPath(new URL("./fixtures", import.meta.url));

function transformOf(plugin: Plugin) {
  return plugin.transform as (
    code: string,
    id: string,
  ) => Promise<{ code: string; map?: unknown } | null>;
}

function plugins(sourceLocations = false) {
  return [aiui(), prompts({ sourceLocations }), solid({ exclude: promptFilePattern })];
}

describe("prompt JSX dialect routing", () => {
  it("the installed Solid compiler itself excludes prompt files before reading JSX", async () => {
    const solidPlugins = solid({ exclude: promptFilePattern }) as Plugin[];
    const compiler = solidPlugins.find((plugin) => plugin.name === "solid");
    expect(compiler).toBeDefined();
    const transform = transformOf(compiler as Plugin);
    for (const id of ["/app/greeting.prompt.tsx", "/app/greeting.prompt.tsx?t=123"]) {
      // The actual installed Solid transform checks its filter before invoking
      // any compiler service. A minimal context suffices for excluded modules.
      expect(await transform.call({}, "export const p = <Text value='Hello' />", id)).toBeNull();
    }
  });

  it("uses the owned JSX runtime and leaves ordinary TSX and asset imports alone", async () => {
    const transform = transformOf(prompts());
    const source = "export const p = <Text value={'Hello Ada'} />";
    const result = await transform(source, "/app/greeting.prompt.tsx?t=123");
    expect(result?.code).toContain("@habemus-papadum/aiui-prompts/jsx-runtime");
    expect(result?.code).not.toContain("<Text");
    expect(result?.map).toBeTruthy();
    for (const id of [
      "/app/App.tsx",
      "/app/greeting.prompt.tsx?raw",
      "/app/greeting.prompt.tsx?url",
      "/app/greeting.prompt.ts",
    ]) {
      expect(await transform(source, id)).toBeNull();
    }
    expect(promptFilePattern.test("/app/greeting.prompt.tsx?t=123")).toBe(true);
  });

  it("rejects a pragma that would silently switch JSX runtimes", async () => {
    const transform = transformOf(prompts());
    await expect(
      transform("/** @jsxImportSource @solidjs/web */\nconst p = <Text />;", "/x.prompt.tsx"),
    ).rejects.toThrow("prompt JSX requires @jsxImportSource @habemus-papadum/aiui-prompts");
    await expect(
      transform("/** @jsxRuntime classic */\nconst p = <Text />;", "/x.prompt.tsx"),
    ).rejects.toThrow("prompt JSX requires @jsxRuntime automatic");
    const result = await transform(
      'const example = "/** @jsxImportSource another-library */"; export const p = <Text value={example} />;',
      "/x.prompt.tsx",
    );
    expect(result?.code).toContain("@habemus-papadum/aiui-prompts/jsx-runtime");
  });

  it("serves both dialects through real aiui + Solid + prompt plugins", async () => {
    const server = await createServer({
      configFile: false,
      root,
      plugins: plugins(),
      logLevel: "silent",
      server: { middlewareMode: true, watch: null, hmr: false },
      optimizeDeps: { noDiscovery: true, include: [] },
      ssr: { noExternal: ["@habemus-papadum/aiui-prompts"] },
    });
    try {
      const prompt = await server.transformRequest("/greeting.prompt.tsx");
      expect(prompt?.code).toContain("jsx-runtime");
      expect(prompt?.code).not.toContain("data-source-loc");
      expect(prompt?.code).not.toContain("@solidjs/web");
      const app = await server.transformRequest("/App.tsx");
      expect(app?.code).toContain("data-source-loc");
      expect(app?.code).toContain("App.tsx:3:");
      expect(app?.code).not.toContain("<main>");
      const executed = await server.ssrLoadModule("/greeting.prompt.tsx");
      expect(typeof executed.prompt).toBe("object");
      expect(JSON.stringify(executed.prompt)).toContain("Hello Ada");
    } finally {
      await server.close();
    }
  });

  it.each([
    false,
    true,
  ])("builds both JSX dialects with source capture = %s", async (sourceLocations) => {
    const result = await build({
      configFile: false,
      root,
      plugins: plugins(sourceLocations),
      logLevel: "silent",
      build: {
        write: false,
        minify: false,
        sourcemap: true,
        lib: { entry: `${root}/entry.ts`, formats: ["es"] },
        rolldownOptions: {
          external: [/^(?:solid-js|@solidjs\/web)(?:\/|$)/],
        },
      },
    });
    const outputs = Array.isArray(result) ? result : [result];
    const code = outputs
      .flatMap((output) => ("output" in output ? output.output : []))
      .filter((output) => output.type === "chunk")
      .map((output) => output.code)
      .join("\n");
    expect(code).toContain("Hello Ada");
    expect(code).toContain("Ordinary Solid UI");
    expect(code).toContain("data-source-loc");
    expect(code).toContain("App.tsx:3:");
    expect(code).not.toMatch(/greeting\.prompt\.tsx:\d+:/);
    expect(code).not.toContain("<Text");
    expect(code).not.toContain("<Prompt");
  });
});
