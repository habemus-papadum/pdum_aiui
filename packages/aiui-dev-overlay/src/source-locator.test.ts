import { transformAsync } from "@babel/core";
import type { Plugin } from "vite";
import { describe, expect, it } from "vitest";
import {
  optionsFactory,
  type SourceLocatorOptions,
  sourceLocatorBabel,
  sourceLocatorVite,
} from "./source-locator";

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

describe("factory table — control()/action() identity (the aiui compiler)", () => {
  it("infers a control's name from its export binding and injects name + loc", async () => {
    const out = await run(`export const kappa = control({ value: 0.1 });`, "src/model/store.ts");
    expect(out).toContain('name: "kappa"');
    expect(out).toContain('loc: "src/model/store.ts:1"');
  });

  it("lifts a JSDoc description from the declaration, tags stripped", async () => {
    const out = await run(
      `/**
 * Diffusion constant, how fast heat spreads.
 * @remarks internal
 */
export const kappa = control({ value: 0.1 });`,
      "src/model/store.ts",
    );
    expect(out).toContain('description: "Diffusion constant, how fast heat spreads."');
    expect(out).not.toMatch(/description: "[^"]*@remarks/); // tags never leak in
  });

  it("lifts a contiguous // run as one description, and takes the CLOSEST comment", async () => {
    const out = await run(
      `// ---- parameters ----------------------------------------------------
// Time step for the explicit scheme.
// Halve it if the profile oscillates.
export const dt = control({ value: 0.01 });`,
      "src/model/store.ts",
    );
    expect(out).toContain(
      'description: "Time step for the explicit scheme. Halve it if the profile oscillates."',
    );
    expect(out).not.toMatch(/description: "[^"]*parameters/); // the banner never leaks in
  });

  it("ignores directive comments (biome-ignore, scenery fences) as descriptions", async () => {
    const out = await run(
      `// biome-ignore lint/suspicious/noExplicitAny: probe
// <aiui-scenery>
export const k = control({ value: 1 });`,
      "src/s.ts",
    );
    expect(out).toContain('name: "k"');
    expect(out).not.toContain("description");
  });

  it("explicit name and description always win over inference and comments", async () => {
    const out = await run(
      `/** comment loses */
export const binding = control({ name: "kappa", description: "explicit wins", value: 1 });`,
      "src/s.ts",
    );
    expect(out).toContain('name: "kappa"');
    expect(out).not.toContain('name: "binding"');
    expect(out).toContain('description: "explicit wins"');
    expect(out).not.toContain('description: "comment loses"');
  });

  it("rejects a non-literal explicit name with a code-framed compile error", async () => {
    await expect(
      run(`const c = control({ name: "k" + suffix, value: 1 });`, "src/s.ts"),
    ).rejects.toThrow(/compile-time string literal/);
    // Template literals are rejected even without placeholders — strictness
    // keeps the rule statable in one sentence: a plain "…" string, nothing else.
    await expect(
      run("const c = control({ name: `kappa`, value: 1 });", "src/s.ts"),
    ).rejects.toThrow(/compile-time string literal/);
  });

  it("rejects an anonymous control (no binding, no explicit name) — names are keys", async () => {
    await expect(run(`register(control({ value: 1 }));`, "src/s.ts")).rejects.toThrow(
      /needs a name/,
    );
  });

  it("a bare action() statement still lifts its comment but requires an explicit name", async () => {
    const out = await run(
      `/** New noise seed; the profile recomputes. */
action({ name: "re-seed", run: () => reseed() });`,
      "src/model/graph.ts",
    );
    expect(out).toContain('description: "New noise seed; the profile recomputes."');
    await expect(run(`action({ run: () => reseed() });`, "src/s.ts")).rejects.toThrow(
      /needs a name/,
    );
  });

  it("leaves a non-object options expression alone (runtime guard is the backstop)", async () => {
    const src = `const kappa = control(makeOpts());`;
    expect(await run(src, "src/s.ts")).toContain("control(makeOpts())");
  });

  it("cells also gain lifted descriptions — on graph object properties too", async () => {
    const out = await run(
      `const graph = {
  /** The evolving profile. */
  profile: cell(deps, compute),
};`,
      "src/model/graph.ts",
    );
    expect(out).toContain('name: "profile"');
    expect(out).toContain('description: "The evolving profile."');
  });

  it("back-compat: cellFactories narrows the table (control untouched), [] disables it", async () => {
    const src = `const kappa = control({ value: 1 });\nconst c = cell(d, f);`;
    const narrowed = await run(src, "src/s.ts", { cellFactories: ["cell"] });
    expect(narrowed).toContain("control({\n  value: 1\n})"); // untouched
    expect(narrowed).toContain('name: "c"');
    const off = await run(src, "src/s.ts", { cellFactories: [] });
    expect(off).not.toContain("name:");
  });

  it("a custom factories table is honored end to end", async () => {
    const out = await run(`export const w = widget({ kind: "slider" });`, "src/s.ts", {
      factories: [optionsFactory("widget")],
    });
    expect(out).toContain('name: "w"');
    expect(out).toContain('loc: "src/s.ts:1"');
  });

  it("stampJsx: false keeps identity injection while skipping instrumentation", async () => {
    const out = await run(
      `const v = <div/>;\nexport const kappa = control({ value: 1 });`,
      "src/a.tsx",
      { stampJsx: false },
    );
    expect(out).not.toContain("data-source-loc");
    expect(out).toContain('name: "kappa"');
  });
});

describe("sourceLocatorVite — plugin surface", () => {
  it("is a pre plugin that applies to serve AND build (identity is load-bearing)", () => {
    const p = sourceLocatorVite();
    expect(p.enforce).toBe("pre");
    // No `apply` gate: a control's compiled-in name is its durable key and
    // tool identity, so production builds must run the injection half too.
    expect(p.apply).toBeUndefined();
  });

  it("stamps JSX under serve but not under build; injection runs in both", async () => {
    const stamped = "const k = <div/>;\nexport const kappa = control({ value: 1 });";
    const serve = sourceLocatorVite();
    (serve.configResolved as (c: object) => void)({ root: "/app", command: "serve" });
    const dev = await transformOf(serve)(stamped, "/app/src/a.tsx");
    expect(dev?.code).toContain("data-source-loc");
    expect(dev?.code).toContain('name: "kappa"');

    const build = sourceLocatorVite();
    (build.configResolved as (c: object) => void)({ root: "/app", command: "build" });
    const prod = await transformOf(build)(stamped, "/app/src/a.tsx");
    expect(prod?.code).not.toContain("data-source-loc"); // instrumentation is dev-only
    expect(prod?.code).toContain('name: "kappa"'); // identity is not
  });

  it("transform skips node_modules and content with nothing to stamp", async () => {
    const t = transformOf(sourceLocatorVite());
    expect(await t("const x = <div/>;", "/app/node_modules/pkg/a.tsx")).toBeNull();
    expect(await t("const x = 1;", "/app/src/plain.ts")).toBeNull();
    expect(await t("body { color: red }", "/app/src/styles.css")).toBeNull();
  });

  it("stamps through the full transform, relative to the resolved root", async () => {
    const p = sourceLocatorVite();
    (p.configResolved as (c: object) => void)({ root: "/app", command: "serve" });
    const result = await transformOf(p)("const x = <div/>;", "/app/src/a.tsx");
    expect(result?.code).toContain('data-source-loc="src/a.tsx:1:11"');
  });

  it("an explicit root option wins over the resolved Vite root", async () => {
    const p = sourceLocatorVite({ root: "/other" });
    (p.configResolved as (c: object) => void)({ root: "/app", command: "serve" });
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
