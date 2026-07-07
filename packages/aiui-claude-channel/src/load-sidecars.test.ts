import { describe, expect, it, vi } from "vitest";
import { loadSidecars, parseSidecarDescriptors, type SidecarDescriptor } from "./load-sidecars";
import type { Sidecar } from "./sidecar";

const makeSidecar = (name: string): Sidecar => ({ name, mount: () => ({}) });

describe("loadSidecars", () => {
  it("resolves a descriptor via the injected import hook and returns its Sidecar", async () => {
    // A fixture factory stands in for a real package's export; the injected
    // import hook maps the descriptor's `module` to a module exposing it.
    const factory = vi.fn(() => makeSidecar("code"));
    const importHook = vi.fn(async () => ({ default: factory }));

    const descriptors: SidecarDescriptor[] = [
      { name: "code", module: "@scope/reader/sidecar", options: { root: "/proj" } },
    ];
    const sidecars = await loadSidecars(descriptors, { import: importHook, log: () => {} });

    expect(importHook).toHaveBeenCalledWith("@scope/reader/sidecar");
    // The descriptor's opaque `options` reach the factory verbatim.
    expect(factory).toHaveBeenCalledWith({ root: "/proj" });
    expect(sidecars.map((s) => s.name)).toEqual(["code"]);
  });

  it("defaults to the `default` export and honors an explicit `export`", async () => {
    const mod = {
      default: vi.fn(() => makeSidecar("via-default")),
      makeCode: vi.fn(() => makeSidecar("via-named")),
    };
    const importHook = async () => mod;

    const viaDefault = await loadSidecars([{ name: "d", module: "m" }], {
      import: importHook,
      log: () => {},
    });
    expect(mod.default).toHaveBeenCalledOnce();
    expect(viaDefault.map((s) => s.name)).toEqual(["via-default"]);

    const viaNamed = await loadSidecars([{ name: "n", module: "m", export: "makeCode" }], {
      import: importHook,
      log: () => {},
    });
    expect(mod.makeCode).toHaveBeenCalledOnce();
    expect(viaNamed.map((s) => s.name)).toEqual(["via-named"]);
  });

  it("skips a throwing / absent / non-Sidecar factory without sinking the others", async () => {
    const log = vi.fn();
    const importHook = async (specifier: string) => {
      switch (specifier) {
        case "boom":
          return {
            default: () => {
              throw new Error("kaboom");
            },
          };
        case "not-a-fn":
          return { default: 42 }; // export exists but isn't callable
        case "missing":
          throw new Error("cannot find module 'missing'"); // import itself rejects
        case "wrong-shape":
          return { default: () => ({ nope: true }) }; // factory returns a non-Sidecar
        case "good":
          return { default: () => makeSidecar("good") };
        default:
          throw new Error(`unexpected specifier ${specifier}`);
      }
    };

    const sidecars = await loadSidecars(
      [
        { name: "boom", module: "boom" },
        { name: "not-a-fn", module: "not-a-fn" },
        { name: "missing", module: "missing" },
        { name: "wrong-shape", module: "wrong-shape" },
        { name: "good", module: "good" },
      ],
      { import: importHook, log },
    );

    // Only the healthy descriptor survives; the four bad ones were logged + skipped.
    expect(sidecars.map((s) => s.name)).toEqual(["good"]);
    expect(log.mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it("returns an empty array for no descriptors", async () => {
    expect(await loadSidecars([], { log: () => {} })).toEqual([]);
  });
});

describe("parseSidecarDescriptors", () => {
  it("parses a JSON array of descriptors", () => {
    const out = parseSidecarDescriptors(
      JSON.stringify([
        { name: "code", module: "@scope/reader/sidecar", options: { root: "/p" } },
        { name: "git", module: "@scope/git/sidecar", export: "makeGit" },
      ]),
      { log: () => {} },
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ name: "code", module: "@scope/reader/sidecar" });
    expect(out[1]?.export).toBe("makeGit");
  });

  it("tolerates malformed JSON — returns [] and logs", () => {
    const log = vi.fn();
    expect(parseSidecarDescriptors("{not json", { log })).toEqual([]);
    expect(log).toHaveBeenCalled();
  });

  it("returns [] for a non-array top-level value", () => {
    expect(parseSidecarDescriptors('{"name":"x","module":"m"}', { log: () => {} })).toEqual([]);
  });

  it("drops entries missing a string name/module but keeps the good ones", () => {
    const out = parseSidecarDescriptors(
      JSON.stringify([{ name: "ok", module: "m" }, { name: "missing-module" }, 7]),
      { log: () => {} },
    );
    expect(out.map((d) => d.name)).toEqual(["ok"]);
  });
});
