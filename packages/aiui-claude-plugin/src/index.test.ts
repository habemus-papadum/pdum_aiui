import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listPlugins, marketplaceDir, name, pluginDir } from "./index";

describe(name, () => {
  it("resolves an existing marketplace directory with a manifest", () => {
    const dir = marketplaceDir();
    expect(dir.endsWith("marketplace")).toBe(true);
    expect(existsSync(join(dir, ".claude-plugin", "marketplace.json"))).toBe(true);
  });

  it("lists the bundled plugins", () => {
    expect(listPlugins()).toEqual(["aiui", "frontend-design", "session-browser"]);
  });

  it("resolves each bundled plugin to a directory with a plugin manifest", () => {
    for (const plugin of listPlugins()) {
      const dir = pluginDir(plugin);
      expect(existsSync(join(dir, ".claude-plugin", "plugin.json"))).toBe(true);
    }
  });

  it("names the available plugins when asked for a missing one", () => {
    expect(() => pluginDir("nope")).toThrow(/no bundled plugin named "nope".*session-browser/);
  });
});
