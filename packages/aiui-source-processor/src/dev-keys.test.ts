/**
 * The devKeys seed: resolved keys become one `__AIUI__.devKeys` script tag,
 * missing providers warn loudly with the remedy, and resolution happens ONCE
 * per server run (the vault must not be shelled per page load).
 */
import type { ResolvedVendorKeys } from "@habemus-papadum/aiui-util";
import { describe, expect, it } from "vitest";
import { devKeysSeed } from "./index.ts";

function resolved(openaiValue?: string): ResolvedVendorKeys {
  return {
    openai: {
      provider: "openai",
      envVar: "OPENAI_API_KEY",
      label: "OpenAI",
      ...(openaiValue !== undefined
        ? { source: "env" as const, value: openaiValue }
        : { source: "missing" as const }),
    },
    gemini: { provider: "gemini", envVar: "GEMINI_API_KEY", label: "Gemini", source: "missing" },
    elevenlabs: {
      provider: "elevenlabs",
      envVar: "ELEVEN_LABS_API_KEY",
      label: "ElevenLabs",
      source: "missing",
    },
  };
}

type TransformHook = () => Promise<Array<{ children: string }>>;

function run(plugin: ReturnType<typeof devKeysSeed>, warnings: string[]) {
  (plugin.configResolved as unknown as (config: unknown) => void)({
    logger: { warn: (message: string) => warnings.push(message) },
  });
  return (plugin.transformIndexHtml as unknown as TransformHook)();
}

describe("devKeysSeed", () => {
  it("seeds __AIUI__.devKeys with the resolved keys, once", async () => {
    let resolves = 0;
    const plugin = devKeysSeed(["openai"], async () => {
      resolves += 1;
      return resolved("sk-dev");
    });
    const warnings: string[] = [];
    const tags = await run(plugin, warnings);
    expect(tags[0]?.children).toContain('.devKeys = {"openai":"sk-dev"}');
    expect(warnings).toEqual([]);
    await (plugin.transformIndexHtml as unknown as TransformHook)();
    expect(resolves).toBe(1); // per-server, not per-page
  });

  it("a missing provider warns LOUDLY with both remedies and seeds nothing", async () => {
    const plugin = devKeysSeed(["openai"], async () => resolved());
    const warnings: string[] = [];
    const tags = await run(plugin, warnings);
    expect(tags).toEqual([]);
    expect(warnings[0]).toContain("OPENAI_API_KEY");
    expect(warnings[0]).toContain("aiui keys set openai");
  });
});
