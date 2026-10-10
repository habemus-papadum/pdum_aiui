import { execFile } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "vite";
import { expect, it } from "vitest";

const run = promisify(execFile);
const workspace = fileURLToPath(new URL("../../../", import.meta.url));
const require = createRequire(import.meta.url);
const tsc = require.resolve("typescript/bin/tsc");
const scope = "@habemus-papadum/";
const names = ["aiui-prompts", "aiui-prompts-inspector", "aiui-prompts-vite"];

async function command(file: string, args: string[], cwd: string) {
  try {
    return await run(file, args, { cwd });
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string };
    throw new Error(`${failure.message}\n${failure.stdout ?? ""}\n${failure.stderr ?? ""}`, {
      cause: failure,
    });
  }
}

const node = (args: string[], cwd: string) => command(process.execPath, args, cwd);

/** Real manifests and pnpm pack, with build outputs isolated from dev servers and other builds. */
async function packPackage(slug: string, temporary: string) {
  const source = join(workspace, "packages", slug);
  const staging = join(temporary, "workspace", "packages", slug);
  const dist = join(staging, "dist");
  await mkdir(dist, { recursive: true });
  await cp(join(source, "src"), join(staging, "src"), { recursive: true });
  await cp(join(source, "package.json"), join(staging, "package.json"));
  // pnpm resolves workspace: dependencies while packing. This link is only for
  // pack's metadata resolution; installed consumer code never sees source links.
  await symlink(join(source, "node_modules"), join(staging, "node_modules"), "dir");
  const result = await build({
    root: source,
    configFile: join(source, "vite.config.ts"),
    logLevel: "silent",
    build: { write: false },
  });
  const builds = Array.isArray(result) ? result : [result];
  const outputs = builds.flatMap((output) => ("output" in output ? output.output : []));
  expect(outputs.length).toBeGreaterThan(0);
  for (const output of outputs) {
    const target = join(dist, output.fileName);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, output.type === "chunk" ? output.code : output.source);
  }
  await node(
    [tsc, "-p", join(source, "tsconfig.json"), "--outDir", dist, "--declarationDir", dist],
    source,
  );
  const tarballs = join(temporary, "tarballs", slug);
  await mkdir(tarballs, { recursive: true });
  await command("pnpm", ["pack", "--pack-destination", tarballs], staging);
  const archives = (await readdir(tarballs)).filter((file) => file.endsWith(".tgz"));
  expect(archives).toHaveLength(1);
  const installed = join(temporary, "consumer", "node_modules", scope, slug);
  await mkdir(installed, { recursive: true });
  await command(
    "tar",
    ["-xzf", join(tarballs, archives[0]), "--strip-components=1", "-C", installed],
    temporary,
  );
  return { installed, source, outputs };
}

it("packs separate public packages and runs core without runtime or browser dependencies", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "aiui-prompts-package-"));
  const consumer = join(temporary, "consumer");
  try {
    await mkdir(join(temporary, "workspace"), { recursive: true });
    await cp(
      join(workspace, "pnpm-workspace.yaml"),
      join(temporary, "workspace", "pnpm-workspace.yaml"),
    );
    await writeFile(
      join(temporary, "workspace", "package.json"),
      JSON.stringify({ private: true }),
    );
    const packages = [];
    for (const slug of names) packages.push(await packPackage(slug, temporary));
    const core = packages[0];
    const manifests = await Promise.all(
      packages.map(async ({ installed }) =>
        JSON.parse(await readFile(join(installed, "package.json"), "utf8")),
      ),
    );
    for (const manifest of manifests) {
      expect(manifest.private).not.toBe(true);
      expect(manifest.main).toBe("./dist/index.js");
      expect(manifest.types).toBe("./dist/index.d.ts");
      expect(JSON.stringify(manifest)).not.toContain("workspace:");
      expect(JSON.stringify(manifest)).not.toContain("catalog:");
    }
    expect(manifests[0].dependencies ?? {}).toEqual({});
    expect(manifests[0].peerDependencies ?? {}).toEqual({});
    expect(Object.keys(manifests[0].exports).sort()).toEqual([
      ".",
      "./analysis",
      "./jsx-dev-runtime",
      "./jsx-runtime",
      "./operations",
    ]);
    expect(Object.keys(manifests[1].dependencies)).not.toContain("vite");
    expect(Object.keys(manifests[2].dependencies)).not.toContain("katex");
    expect(Object.keys(manifests[2].dependencies).some((key) => key.includes("mdast"))).toBe(false);
    await writeFile(
      join(consumer, "package.json"),
      JSON.stringify({ private: true, type: "module" }),
    );

    // Fail if even a transitive import of the core root loads operations. This
    // loader observes the actual ESM graph rather than trusting tree shaking.
    await writeFile(
      join(consumer, "root-only.mjs"),
      `
export async function load(url, context, nextLoad) {
  if (url.includes('/operations') || url.includes('/analysis')) throw new Error('Root imported optional module: ' + url);
  return nextLoad(url, context);
}
`,
    );
    const rootExecution = await node(
      [
        "--loader",
        "./root-only.mjs",
        "--input-type=module",
        "--eval",
        `
for (const key of ['window', 'document', 'HTMLElement', 'navigator']) {
  Object.defineProperty(globalThis, key, { get() { throw new Error('Core read DOM: ' + key); }, configurable: true });
}
const core = await import('${scope}aiui-prompts');
if ('responseOperation' in core) throw new Error('Operations leaked from root');
const record = core.snapshot(core.Text({value: 'portable core'}));
if (core.compilePrompt(record).parts[0].text !== 'portable core') throw new Error('Core failed');
console.log('root-only-ok');
`,
      ],
      consumer,
    );
    expect(rootExecution.stdout.trim()).toBe("root-only-ok");

    // No third-party dependencies have been installed in this consumer.
    const execution = await node(
      [
        "--input-type=module",
        "--eval",
        `
import * as core from '${scope}aiui-prompts';
import { jsx } from '${scope}aiui-prompts/jsx-runtime';
import { jsxDEV } from '${scope}aiui-prompts/jsx-dev-runtime';
import { parseOperation } from '${scope}aiui-prompts/operations';
import { measurePrompt } from '${scope}aiui-prompts/analysis';
const value = jsx(core.Prompt, {children: jsx(core.Text, {value: 'built boundary'})});
const record = core.parseRecord(core.serializeRecord(core.snapshot(value)));
const compiled = core.compilePrompt(record);
if (compiled.parts[0].text !== 'built boundary') throw new Error('Built prompt failed');
if (typeof jsxDEV !== 'function' || typeof parseOperation !== 'function') throw new Error('Missing export');
measurePrompt(compiled);
console.log('built-core-ok');
`,
      ],
      consumer,
    );
    expect(execution.stdout.trim()).toBe("built-core-ok");
    const modelExecution = await node(
      [
        "--input-type=module",
        "--eval",
        `
for (const key of ['window', 'document', 'HTMLElement', 'navigator']) {
  Object.defineProperty(globalThis, key, { get() { throw new Error('Model read DOM: ' + key); }, configurable: true });
}
const { InspectorController } = await import('${scope}aiui-prompts-inspector/model');
const { snapshot, Text } = await import('${scope}aiui-prompts');
const controller = new InspectorController(JSON.stringify(snapshot(Text({value: 'stored prompt'}))));
if (controller.compiled.parts[0].text !== 'stored prompt') throw new Error('Headless model failed');
controller.dispose();
console.log('headless-model-ok');
`,
      ],
      consumer,
    );
    expect(modelExecution.stdout.trim()).toBe("headless-model-ok");
    await cp(
      new URL("./packaging.consumer.prompt.tsx", import.meta.url),
      join(consumer, "consumer.prompt.tsx"),
    );
    await writeFile(
      join(consumer, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          noEmit: true,
          types: [],
          jsx: "react-jsx",
          jsxImportSource: `${scope}aiui-prompts`,
          skipLibCheck: false,
        },
        include: ["consumer.prompt.tsx"],
      }),
    );
    await node([tsc, "-p", join(consumer, "tsconfig.json")], consumer);
    // Only declared third-party UI/build dependencies and their peers are linked
    // now; every @habemus-papadum import still resolves to its actual tarball.
    for (let index = 1; index < packages.length; index++) {
      const { installed, source } = packages[index];
      const manifest = manifests[index];
      for (const dependency of Object.keys({
        ...manifest.dependencies,
        ...manifest.peerDependencies,
      })) {
        if (dependency.startsWith(scope)) continue;
        const target = join(installed, "node_modules", dependency);
        await mkdir(dirname(target), { recursive: true });
        await symlink(await realpath(join(source, "node_modules", dependency)), target, "dir");
      }
    }
    await writeFile(
      join(consumer, "inspector.consumer.ts"),
      `
import { mountInspector, mountPreview, type PromptPreviewProps } from '${scope}aiui-prompts-inspector';
import { InspectorController, loadInspection } from '${scope}aiui-prompts-inspector/model';
export const entries = [mountInspector, mountPreview, InspectorController, loadInspection];
export const props: PromptPreviewProps = { record: 'stored JSON' };
`,
    );
    await node(
      [
        tsc,
        "--noEmit",
        "--strict",
        "--skipLibCheck",
        "false",
        "--module",
        "NodeNext",
        "--moduleResolution",
        "NodeNext",
        "--target",
        "ES2022",
        "inspector.consumer.ts",
      ],
      consumer,
    );
    // A small installed-artifact DOM smoke test supplements the source-level
    // interaction suite. jsdom is a test-only dependency, never a viewer dependency.
    await symlink(
      await realpath(join(packages[1].source, "node_modules", "jsdom")),
      join(consumer, "node_modules", "jsdom"),
      "dir",
    );
    await node(
      [
        "--conditions=browser",
        "--conditions=development",
        "--input-type=module",
        "--eval",
        `
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><html><body><main></main></body></html>', {pretendToBeVisual: true});
for (const key of ['window', 'document', 'HTMLElement', 'Node', 'Element', 'MutationObserver']) globalThis[key] = dom.window[key];
const { mountPreview } = await import('${scope}aiui-prompts-inspector');
const { snapshot, Text } = await import('${scope}aiui-prompts');
const container = document.querySelector('main');
const mounted = mountPreview(container, JSON.stringify(snapshot(Text({value: '**Packed preview**'}))));
if (container.querySelector('strong')?.textContent !== 'Packed preview') throw new Error('Packed Solid preview did not render Markdown');
mounted.dispose();
if (container.childElementCount !== 0) throw new Error('Packed Solid preview did not dispose');
dom.window.close();
`,
      ],
      consumer,
    );
    await node(
      [
        "--input-type=module",
        "--eval",
        `
import {prompts} from '${scope}aiui-prompts-vite';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
if (prompts().name !== 'aiui-prompts:tsx') throw new Error('Missing Vite plugin');
for (const path of ['style.css', 'themes/aiui.css', 'themes/terminal.css']) {
  if (!readFileSync(createRequire(import.meta.url).resolve('${scope}aiui-prompts-inspector/' + path), 'utf8').length) throw new Error('Missing CSS: ' + path);
}
`,
      ],
      consumer,
    );
    expect(core.outputs.some((output) => output.fileName.includes("inspector"))).toBe(false);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}, 60_000);
