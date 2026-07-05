import { transformAsync } from "@babel/core";
import type { Plugin } from "vite";
import { describe, expect, it } from "vitest";
import { type SourceLocatorOptions, sourceLocatorBabel, sourceLocatorVite } from "./source-locator";

/**
 * Run the babel plugin in isolation (no Solid preset) and return the output.
 * Babel absolutizes a relative `filename` against cwd, so — mirroring how the
 * Vite plugin passes an absolute id plus the resolved root — a `path` without
 * its own `root` option is placed under a synthetic root and relativized back.
 */
const ROOT = "/proj";
async function run(
  code: string,
  path: string,
  options: SourceLocatorOptions = {},
): Promise<string> {
  const root = options.root ?? ROOT;
  const filename = options.root === undefined ? `${ROOT}/${path}` : path;
  const isJsx = /x$/.test(filename);
  const result = await transformAsync(code, {
    filename,
    parserOpts: { plugins: isJsx ? ["jsx", "typescript"] : ["typescript"] },
    plugins: [[sourceLocatorBabel, { ...options, root }]],
    configFile: false,
    babelrc: false,
  });
  return result?.code ?? "";
}

// The transform/buildStart hooks are plain functions; grab them typed.
const transformOf = (p: Plugin) =>
  p.transform as (code: string, id: string) => Promise<{ code: string } | null>;
const buildStartOf = (p: Plugin) => p.buildStart as () => Promise<void>;

describe("sourceLocatorBabel — JSX stamping", () => {
  it("stamps every host JSX element, including nested ones, but not components", async () => {
    const code = `
      function Panel() {
        return (
          <section>
            <h2>Title</h2>
            <Child />
          </section>
        );
      }
    `;
    const out = await run(code, "src/ui/Panel.tsx");
    const stamps = out.match(/data-source-loc="[^"]+"/g) ?? [];
    // section + h2 are host elements; Child (a component) is not stamped.
    expect(stamps).toHaveLength(2);
    expect(out).toContain('data-source-loc="src/ui/Panel.tsx:');
    expect(out).not.toMatch(/<Child[^>]*data-source-loc/);
  });

  it("relativizes stamped paths against root, 1-based line:col", async () => {
    const out = await run("const x = <div/>;", "/abs/app/src/a.tsx", { root: "/abs/app" });
    expect(out).toContain('data-source-loc="src/a.tsx:1:11"');
  });

  it("does not double-stamp an element that already has the attribute", async () => {
    const out = await run('const x = <div data-source-loc="hand:1:1"/>;', "src/a.tsx");
    expect(out.match(/data-source-loc=/g) ?? []).toHaveLength(1);
    expect(out).toContain('data-source-loc="hand:1:1"');
  });
});

describe("sourceLocatorBabel — cell() call-site identity", () => {
  it("injects { name, loc } for declarator, property, and assignment sites", async () => {
    const code = [
      "const catalog = cell(deps, compute);",
      "const graph = { analysis: cell(a, b) };",
      "let handle;",
      "handle = cell(c, d);",
    ].join("\n");
    const out = await run(code, "src/model/graph.ts");
    expect(out).toContain('name: "catalog"');
    expect(out).toContain('name: "analysis"');
    expect(out).toContain('name: "handle"');
    expect(out).toMatch(/loc: "src\/model\/graph\.ts:\d+"/);
  });

  it("leaves anonymous cell() calls untouched", async () => {
    const out = await run("register(cell(a, b));", "src/m.ts");
    expect(out).not.toContain("name:");
  });

  it("cellFactories: [] disables the call-site half (JSX still stamped)", async () => {
    const noCells = await run("const catalog = cell(a, b);", "src/model/graph.ts", {
      cellFactories: [],
    });
    expect(noCells).not.toContain("name:");
    const jsx = await run("const x = <div/>;", "src/a.tsx", { cellFactories: [] });
    expect(jsx).toContain("data-source-loc=");
  });

  it("honors configurable factory names", async () => {
    const out = await run("const s = signal(a, b);\nconst c = cell(x, y);", "src/m.ts", {
      cellFactories: ["signal"],
    });
    expect(out).toContain('name: "s"');
    expect(out).not.toContain('name: "c"');
  });

  it("merges into an existing options object without clobbering it", async () => {
    const out = await run('const c = cell(a, b, { stream: "latest" });', "src/m.ts");
    expect(out).toContain('stream: "latest"');
    expect(out).toContain('name: "c"');
    expect(out).toMatch(/loc: "src\/m\.ts:1"/);
  });

  it("preserves a name/loc already present in the options object", async () => {
    const out = await run('const c = cell(a, b, { name: "custom" });', "src/m.ts");
    expect(out).toContain('name: "custom"');
    expect(out).not.toContain('name: "c"');
    expect(out).toMatch(/loc: "src\/m\.ts:1"/);
  });
});

describe("sourceLocatorVite — plugin surface", () => {
  it("is a pre, serve-only plugin", () => {
    const p = sourceLocatorVite();
    expect(p.enforce).toBe("pre");
    expect(p.apply).toBe("serve");
  });

  it("transform skips node_modules and content with nothing to stamp", async () => {
    const t = transformOf(sourceLocatorVite());
    expect(await t("const x = <div/>;", "/app/node_modules/pkg/a.tsx")).toBeNull();
    expect(await t("const x = 1;", "/app/src/plain.ts")).toBeNull();
    expect(await t("body { color: red }", "/app/src/styles.css")).toBeNull();
  });

  it("stamps through the full transform, relative to the resolved root", async () => {
    const p = sourceLocatorVite();
    (p.configResolved as (c: { root: string }) => void)({ root: "/app" });
    const result = await transformOf(p)("const x = <div/>;", "/app/src/a.tsx");
    expect(result?.code).toContain('data-source-loc="src/a.tsx:1:11"');
  });

  it("an explicit root option wins over the resolved Vite root", async () => {
    const p = sourceLocatorVite({ root: "/other" });
    (p.configResolved as (c: { root: string }) => void)({ root: "/app" });
    // File under /app is outside the explicit /other root, so it is skipped.
    expect(await transformOf(p)("const x = <div/>;", "/app/src/a.tsx")).toBeNull();
  });

  it("fails fast with a friendly error when @babel/core is missing", async () => {
    const p = sourceLocatorVite({
      loadBabel: () => Promise.reject(new Error("Cannot find module '@babel/core'")),
    });
    await expect(buildStartOf(p).call(undefined)).rejects.toThrow(/needs @babel\/core/);
  });
});
