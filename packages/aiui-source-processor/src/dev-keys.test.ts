/**
 * The devKeys seed: keys read from the environment become one
 * `__AIUI__.devKeys` script tag, missing providers warn loudly with the
 * env remedy, and resolution happens ONCE per server run.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveDevKeys } from "./dev-keys.ts";
import { devKeysSeed } from "./index.ts";

type TransformHook = () => Array<{ children: string }>;

function run(plugin: ReturnType<typeof devKeysSeed>, warnings: string[]) {
  (plugin.configResolved as unknown as (config: unknown) => void)({
    logger: { warn: (message: string) => warnings.push(message) },
  });
  return (plugin.transformIndexHtml as unknown as TransformHook)();
}

describe("resolveDevKeys", () => {
  it("reads each provider's own variable; blank counts as absent", () => {
    const keys = resolveDevKeys({
      OPENAI_API_KEY: " sk-dev ",
      GEMINI_API_KEY: "   ",
      MOTHERDUCK_TOKEN: "admin-token",
    });
    expect(keys.openai.value).toBe("sk-dev");
    expect(keys.gemini.value).toBeUndefined();
    expect(keys.elevenlabs.value).toBeUndefined();
    // MOTHERDUCK_TOKEN is the admin token a data repo's .env holds — never the
    // browser key; only MOTHERDUCK_BROWSER_TOKEN reaches a page.
    expect(keys.motherduck.value).toBeUndefined();
    expect(keys.motherduck.envVar).toBe("MOTHERDUCK_BROWSER_TOKEN");
    expect(Object.keys(keys).sort()).toEqual(["elevenlabs", "gemini", "motherduck", "openai"]);
  });
});

describe("devKeysSeed", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("applies to serve only — a production bundle structurally cannot carry a key", () => {
    expect(devKeysSeed(["openai"]).apply).toBe("serve");
  });

  it("seeds __AIUI__.devKeys with the requested keys found in the environment, once", () => {
    let resolves = 0;
    const plugin = devKeysSeed(["openai"], () => {
      resolves += 1;
      return resolveDevKeys({ OPENAI_API_KEY: "sk-dev", GEMINI_API_KEY: "g-dev" });
    });
    const warnings: string[] = [];
    const tags = run(plugin, warnings);
    // Only the requested provider is seeded, even though gemini was set.
    expect(tags[0]?.children).toBe('(window.__AIUI__ ??= { v: 1 }).devKeys = {"openai":"sk-dev"};');
    expect(warnings).toEqual([]);
    (plugin.transformIndexHtml as unknown as TransformHook)();
    expect(resolves).toBe(1); // per-server, not per-page
  });

  it("the default resolver reads the dev server's process.env", () => {
    vi.stubEnv("GEMINI_API_KEY", "g-from-env");
    const warnings: string[] = [];
    const tags = run(devKeysSeed(["gemini"]), warnings);
    expect(tags[0]?.children).toContain('.devKeys = {"gemini":"g-from-env"}');
    expect(warnings).toEqual([]);
  });

  it("a missing provider warns LOUDLY with the env remedy and seeds nothing", () => {
    const plugin = devKeysSeed(["openai"], () => resolveDevKeys({}));
    const warnings: string[] = [];
    const tags = run(plugin, warnings);
    expect(tags).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("no OpenAI key");
    expect(warnings[0]).toContain("export OPENAI_API_KEY");
    expect(warnings[0]).toContain(".env");
    expect(warnings[0]).toContain("direnv");
    expect(warnings[0]).not.toContain("aiui keys"); // the vault remedy is gone
  });
});
