import { describe, expect, it } from "vitest";
import { resolveSidecars } from "./sidecars";

/** A `loadManifest` seam that reports a setup at (only) the given roots. */
const manifestAt =
  (...roots: string[]) =>
  (root: string): unknown =>
    roots.includes(root) ? { version: 1 } : undefined;

/** No project ever has a manifest. */
const noManifest = (): unknown => undefined;

/** The descriptor the CLI must emit for the `code` sidecar at `root`. */
const codeDescriptor = (root: string) => ({
  name: "code",
  module: "@habemus-papadum/aiui-code-server/sidecar",
  export: "codeReaderSidecar",
  options: { root },
});

/**
 * Deps for a test: the manifest + language-detection seams plus an identity
 * `resolveModule`, so the emitted `module` stays the bare specifier (the real
 * default resolves it to an absolute path — see sidecars.ts — which needs the
 * package on disk). Detection defaults to "no languages" so the manifest cases
 * stay pure.
 */
const testDeps = (
  loadManifest: (root: string) => unknown,
  detectLanguages: (root: string) => string[] = () => [],
) => ({
  loadManifest,
  detectLanguages,
  resolveModule: (specifier: string) => specifier,
});

describe("resolveSidecars", () => {
  it("auto-enables code when a manifest is present (no flags)", () => {
    expect(
      resolveSidecars("/proj", { enable: [], disable: [] }, testDeps(manifestAt("/proj"))),
    ).toEqual([codeDescriptor("/proj")]);
  });

  it("emits nothing when no manifest is present (no flags)", () => {
    expect(resolveSidecars("/proj", { enable: [], disable: [] }, testDeps(noManifest))).toEqual([]);
  });

  it("force-enables code by name even without a manifest", () => {
    const out = resolveSidecars("/proj", { enable: ["code"], disable: [] }, testDeps(noManifest));
    expect(out).toEqual([codeDescriptor("/proj")]);
    // The exact contract shape, threading the root into options.
    expect(out[0]).toEqual({
      name: "code",
      module: "@habemus-papadum/aiui-code-server/sidecar",
      export: "codeReaderSidecar",
      options: { root: "/proj" },
    });
  });

  it("disable wins over an auto-detected manifest", () => {
    expect(
      resolveSidecars("/proj", { enable: [], disable: ["code"] }, testDeps(manifestAt("/proj"))),
    ).toEqual([]);
  });

  it("disable wins over an explicit enable of the same name", () => {
    expect(
      resolveSidecars(
        "/proj",
        { enable: ["code"], disable: ["code"] },
        testDeps(manifestAt("/proj")),
      ),
    ).toEqual([]);
  });

  it("ignores enable names the CLI doesn't know how to construct", () => {
    expect(
      resolveSidecars("/proj", { enable: ["bogus", "code"], disable: [] }, testDeps(noManifest)),
    ).toEqual([codeDescriptor("/proj")]);
  });

  it("does not enable code when the manifest is at a different root", () => {
    expect(
      resolveSidecars("/proj", { enable: [], disable: [] }, testDeps(manifestAt("/elsewhere"))),
    ).toEqual([]);
  });

  // The chicken-and-egg guard: the backend's LSP bootstrap only runs once the
  // sidecar mounts, so a manifest can't be required for the sidecar to mount.
  it("auto-enables code for a manifest-less project with detectable languages", () => {
    expect(
      resolveSidecars(
        "/proj",
        { enable: [], disable: [] },
        testDeps(noManifest, () => ["typescript"]),
      ),
    ).toEqual([codeDescriptor("/proj")]);
  });

  it("disable wins over language detection too", () => {
    expect(
      resolveSidecars(
        "/proj",
        { enable: [], disable: ["code"] },
        testDeps(noManifest, () => ["python"]),
      ),
    ).toEqual([]);
  });

  it("a throwing language detector is contained (warned, not fatal)", () => {
    const warnings: string[] = [];
    expect(
      resolveSidecars(
        "/proj",
        { enable: [], disable: [] },
        {
          ...testDeps(noManifest, () => {
            throw new Error("walk exploded");
          }),
          log: (m) => warnings.push(m),
        },
      ),
    ).toEqual([]);
    expect(warnings.join("\n")).toContain("walk exploded");
  });
});
