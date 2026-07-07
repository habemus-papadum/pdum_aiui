import { describe, expect, it } from "vitest";
import { resolveSidecars } from "./sidecars";

/** The descriptor the CLI must emit for the `paint` sidecar at `root`. */
const paintDescriptor = (root: string) => ({
  name: "paint",
  module: "@habemus-papadum/aiui-paint/sidecar",
  export: "paintSidecar",
  options: { root },
});

/**
 * Deps for a test: an identity `resolveModule`, so the emitted `module` stays
 * the bare specifier (the real default resolves it to an absolute path — see
 * sidecars.ts — which needs the package on disk).
 */
const testDeps = () => ({
  resolveModule: (specifier: string) => specifier,
});

describe("resolveSidecars", () => {
  it("emits the always-on paint sidecar by default (no flags)", () => {
    const out = resolveSidecars("/proj", { enable: [], disable: [] }, testDeps());
    expect(out).toEqual([paintDescriptor("/proj")]);
    // The exact contract shape, threading the root into options.
    expect(out[0]).toEqual({
      name: "paint",
      module: "@habemus-papadum/aiui-paint/sidecar",
      export: "paintSidecar",
      options: { root: "/proj" },
    });
  });

  it("disable turns off the always-on paint", () => {
    expect(resolveSidecars("/proj", { enable: [], disable: ["paint"] }, testDeps())).toEqual([]);
  });

  it("disable wins over an explicit enable of the same name", () => {
    expect(resolveSidecars("/proj", { enable: ["paint"], disable: ["paint"] }, testDeps())).toEqual(
      [],
    );
  });

  it("ignores enable names the CLI doesn't know how to construct", () => {
    expect(resolveSidecars("/proj", { enable: ["bogus"], disable: [] }, testDeps())).toEqual([
      paintDescriptor("/proj"),
    ]);
  });
});
