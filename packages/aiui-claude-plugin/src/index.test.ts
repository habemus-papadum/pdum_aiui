import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { name, pluginDir } from "./index";

describe(name, () => {
  it("resolves an existing plugin directory path ending in 'plugin'", () => {
    const dir = pluginDir();
    expect(dir.endsWith("plugin")).toBe(true);
    expect(existsSync(dir)).toBe(true);
  });
});
