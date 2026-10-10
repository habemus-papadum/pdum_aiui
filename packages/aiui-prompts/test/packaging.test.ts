import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "vite";
import { expect, it } from "vitest";

const run = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const tsc = require.resolve("typescript/bin/tsc");
const name = "@habemus-papadum/aiui-prompts";

async function node(args: string[], cwd: string) {
  try {
    return await run(process.execPath, args, { cwd });
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string };
    throw new Error(`${failure.message}\n${failure.stdout ?? ""}\n${failure.stderr ?? ""}`, {
      cause: failure,
    });
  }
}

it("runs built exports and readonly declarations outside the workspace", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "aiui-prompts-package-"));
  try {
    const staged = join(temporary, "node_modules", name);
    const dist = join(staged, "dist");
    await mkdir(dist, { recursive: true });
    const result = await build({
      root,
      configFile: join(root, "vite.config.ts"),
      logLevel: "silent",
      build: { write: false },
    });
    const builds = Array.isArray(result) ? result : [result];
    const outputs = builds.flatMap((output) => ("output" in output ? output.output : []));
    expect(outputs.length).toBeGreaterThan(0);
    const styles = [
      "inspector/style.css",
      "inspector/themes/aiui.css",
      "inspector/themes/terminal.css",
    ];
    for (const path of styles)
      expect(
        outputs.some((output) => output.fileName === path),
        path,
      ).toBe(true);
    for (const output of outputs) {
      const target = join(dist, output.fileName);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, output.type === "chunk" ? output.code : output.source);
    }

    // A fresh declaration directory avoids accidentally accepting stale files
    // left by the earlier source-only scaffold's different rootDir.
    await node(
      [tsc, "-p", join(root, "tsconfig.json"), "--outDir", dist, "--declarationDir", dist],
      root,
    );
    const exports: Record<string, unknown> = Object.fromEntries(
      [
        "index",
        "jsx-runtime",
        "jsx-dev-runtime",
        "operations",
        "analysis",
        "vite",
        "inspector/index",
      ].map((entry) => [
        entry === "index" ? "." : entry === "inspector/index" ? "./inspector" : `./${entry}`,
        {
          types: `./dist/${entry.startsWith("inspector/") ? entry : `src/${entry}`}.d.ts`,
          import: `./dist/${entry}.js`,
          default: `./dist/${entry}.js`,
        },
      ]),
    );
    for (const path of styles) exports[`./${path}`] = `./dist/${path}`;
    // This synthetic installed manifest exercises the built shape without
    // changing the deliberately private, source-first workspace manifest.
    await writeFile(
      join(staged, "package.json"),
      JSON.stringify({ name, type: "module", exports }),
    );
    await writeFile(
      join(temporary, "package.json"),
      JSON.stringify({ private: true, type: "module" }),
    );

    // There are deliberately no runtime dependencies installed at this point.
    // Core, JSX, operations, and analysis must run without Vite or preview tools.
    const execution = await node(
      [
        "--input-type=module",
        "--eval",
        `
import * as core from '${name}';
import { jsx } from '${name}/jsx-runtime';
import { jsxDEV } from '${name}/jsx-dev-runtime';
import { parseOperation } from '${name}/operations';
import { measurePrompt } from '${name}/analysis';
const node = jsx(core.Prompt, {children: jsx(core.Text, {value: 'built boundary'})});
const record = core.parseRecord(core.serializeRecord(core.snapshot(node)));
const compiled = core.compilePrompt(record);
if (compiled.parts[0].text !== 'built boundary') throw new Error('Built prompt failed');
if (typeof jsxDEV !== 'function' || typeof parseOperation !== 'function') throw new Error('Missing export');
measurePrompt(compiled);
console.log('built-core-ok');
`,
      ],
      temporary,
    );
    expect(execution.stdout.trim()).toBe("built-core-ok");

    await writeFile(
      join(temporary, "consumer.prompt.tsx"),
      await readFile(new URL("./packaging.consumer.prompt.tsx", import.meta.url), "utf8"),
    );
    await writeFile(
      join(temporary, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          noEmit: true,
          types: [],
          jsx: "react-jsx",
          jsxImportSource: name,
          skipLibCheck: false,
        },
        include: ["consumer.prompt.tsx"],
      }),
    );
    await node([tsc, "-p", join(temporary, "tsconfig.json")], temporary);

    // Build and inspector subpaths work once their declared dependencies exist.
    // Link installed third-party packages only; never link workspace source.
    const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    for (const dependency of [...Object.keys(manifest.dependencies), "vite"]) {
      const target = join(staged, "node_modules", dependency);
      await mkdir(dirname(target), { recursive: true });
      await symlink(await realpath(join(root, "node_modules", dependency)), target, "dir");
    }
    await node(
      [
        "--input-type=module",
        "--eval",
        `
import {prompts} from '${name}/vite';
import {mountInspector} from '${name}/inspector';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
if (prompts().name !== 'aiui-prompts:tsx' || typeof mountInspector !== 'function') throw new Error('Missing built subpath');
for (const path of ${JSON.stringify(styles)}) {
  if (!readFileSync(createRequire(import.meta.url).resolve('${name}/' + path), 'utf8').length) throw new Error('Missing CSS: ' + path);
}
`,
      ],
      temporary,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}, 20_000);
