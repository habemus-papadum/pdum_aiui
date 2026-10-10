import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import aiui from "@habemus-papadum/aiui-source-processor";
import { createServer } from "vite";
import solid from "vite-plugin-solid";
import { describe, expect, it } from "vitest";
import { instrumentPromptSource } from "../../src/instrument.ts";
import type { CompiledPrompt, SemanticRecord } from "../../src/model.ts";
import { promptFilePattern, prompts } from "../../src/vite.ts";

const root = fileURLToPath(new URL("./fixtures", import.meta.url));
const fixture = `${root}/capture.prompt.tsx`;
const source = readFileSync(fixture, "utf8");

async function exercise(sourceLocations: boolean) {
  const server = await createServer({
    configFile: false,
    root,
    plugins: [aiui(), prompts({ sourceLocations }), solid({ exclude: promptFilePattern })],
    logLevel: "silent",
    server: { middlewareMode: true, watch: null, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    ssr: { noExternal: ["@habemus-papadum/aiui-prompts"] },
  });
  try {
    const module = await server.ssrLoadModule("/capture.prompt.tsx");
    return module.exercise() as {
      compiled: CompiledPrompt;
      record: SemanticRecord;
      effects: string[];
    };
  } finally {
    await server.close();
  }
}

describe("optional prompt source owners", () => {
  it("captures revision-qualified construction and interpolation ranges without changing output or effects", async () => {
    const before = await exercise(false);
    const after = await exercise(true);
    expect(after.compiled.parts).toEqual(before.compiled.parts);
    expect(after.compiled.occurrences.map(({ id, kind }) => ({ id, kind }))).toEqual(
      before.compiled.occurrences.map(({ id, kind }) => ({ id, kind })),
    );
    expect(after.compiled.decisions).toEqual(before.compiled.decisions);
    expect(after.effects).toEqual(before.effects);
    expect(after.effects).toContain("props:children");
    expect(after.effects.join(" ")).not.toContain("__promptOrigin");
    expect(before.compiled.occurrences.every((occurrence) => !occurrence.origin)).toBe(true);

    const origins = after.compiled.occurrences.flatMap((occurrence) => occurrence.origins ?? []);
    const revision = `sha256:${createHash("sha256").update(source, "utf8").digest("hex")}`;
    for (const origin of origins) {
      expect(origin).toMatchObject({
        kind: "source",
        file: "capture.prompt.tsx",
        revision,
        precision: "owner",
      });
    }
    const spans = origins.map((origin) => {
      const span = origin.span as { start: number; end: number };
      return { site: origin.site, start: span.start, source: source.slice(span.start, span.end) };
    });
    expect(spans).toContainEqual({
      site: "construction",
      start: source.indexOf('<Leaf value="shared" />'),
      source: '<Leaf value="shared" />',
    });
    // Each placement retains its use site; the same constructed fragment also
    // retains its original construction owner underneath that placement.
    const reuses = spans.filter(
      (span) => span.site === "interpolation" && span.source === "shared",
    );
    expect(new Set(reuses.map((span) => span.start)).size).toBe(4);
    expect(
      spans.some((span) => span.site === "construction" && span.source === "<>{shared}</>"),
    ).toBe(true);
  });

  it("generates collision-free imports and composes maps back to the original source", async () => {
    const result = instrumentPromptSource(source, fixture, root);
    expect(result.code).toContain("withPromptOrigin as __aiuiPromptOrigin_");
    expect(result.map.sources).toEqual([fixture]);
    expect(result.map.sourcesContent).toEqual([source]);
    expect(result.map.mappings).not.toBe("");
    const plugin = prompts({ sourceLocations: true, sourceRoot: root });
    const transform = plugin.transform as (code: string, id: string) => Promise<{ map?: unknown }>;
    const transformed = await transform(source, fixture);
    expect(transformed.map).toMatchObject({ sourcesContent: [source] });
  });

  it("preserves directives and rejects an explicit use of the reserved prop", () => {
    const directed = '"use client";\nexport const x = <>{fragment}</>;';
    const result = instrumentPromptSource(directed, "/app/x.prompt.tsx", "/app");
    expect(result.code.startsWith('"use client";')).toBe(true);
    expect(result.code).toContain("import { withPromptOrigin as __aiuiPromptOrigin }");
    expect(() =>
      instrumentPromptSource("const x=<Text __promptOrigin={{}}/>;", "/app/x.prompt.tsx", "/app"),
    ).toThrow("__promptOrigin is reserved");
  });
});
