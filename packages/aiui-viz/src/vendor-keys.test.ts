import { afterEach, describe, expect, it, vi } from "vitest";
import {
  browserVendorKey,
  pastedVendorKey,
  setPastedVendorKey,
  vendorKeyStorageKey,
} from "./vendor-keys";

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("shared vendor keys", () => {
  it("preserves saved OpenAI keys and isolates providers across reads and clears", () => {
    const saved = storage();
    saved.setItem("aiui.oracle.key", "old-openai");
    expect(browserVendorKey("openai", saved, {})).toBe("old-openai");
    for (const provider of ["motherduck", "elevenlabs"]) {
      expect(setPastedVendorKey(provider, ` ${provider}-pasted `, saved)).toBe(true);
      const seed = { __AIUI__: { devKeys: { [provider]: "dev-value" } } };
      expect(browserVendorKey(provider, saved, seed)).toBe(`${provider}-pasted`);
      expect(pastedVendorKey(provider, saved)).toBe(`${provider}-pasted`);
      setPastedVendorKey(provider, "  ", saved);
      expect(saved.getItem(vendorKeyStorageKey(provider))).toBeNull();
      expect(browserVendorKey(provider, saved, seed)).toBe("dev-value");
      expect(browserVendorKey("openai", saved, {})).toBe("old-openai");
    }
  });

  it("does not copy dev keys into storage and treats blank as absent", () => {
    const saved = storage();
    expect(
      browserVendorKey("motherduck", saved, { __AIUI__: { devKeys: { motherduck: " md " } } }),
    ).toBe("md");
    expect(pastedVendorKey("motherduck", saved)).toBeUndefined();
    expect(
      browserVendorKey("motherduck", saved, { __AIUI__: { devKeys: { motherduck: "  " } } }),
    ).toBeUndefined();
    expect(browserVendorKey("elevenlabs", saved, {})).toBeUndefined();
  });

  it("still reads dev keys when browser storage is unavailable", () => {
    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    vi.stubGlobal("localStorage", blocked);
    expect(setPastedVendorKey("elevenlabs", "secret")).toBe(false);
    expect(
      browserVendorKey("elevenlabs", undefined, { __AIUI__: { devKeys: { elevenlabs: "dev" } } }),
    ).toBe("dev");
  });
});
