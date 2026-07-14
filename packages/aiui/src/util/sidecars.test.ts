import { describe, expect, it } from "vitest";
import { resolveSidecars } from "./sidecars";

/** The descriptor the CLI must emit for the `paint` sidecar at `root`. */
const paintDescriptor = (root: string) => ({
  name: "paint",
  module: "@habemus-papadum/aiui-paint/sidecar",
  export: "paintSidecar",
  options: { root },
});

/** The descriptor for the `intent` sidecar (the channel-served panel). */
const intentDescriptor = (root: string) => ({
  name: "intent",
  module: "@habemus-papadum/aiui-intent-client/sidecar",
  export: "intentSidecar",
  options: { root },
});

/** The descriptor for the always-on `bar` sidecar (the remote command bar). */
const barDescriptor = (root: string) => ({
  name: "bar",
  module: "@habemus-papadum/aiui-remote-bar/sidecar",
  export: "barSidecar",
  options: { root },
});

/** The descriptor for the always-on `pencil` sidecar (the remote pencil). */
const pencilDescriptor = (root: string) => ({
  name: "pencil",
  module: "@habemus-papadum/aiui-pencil/sidecar",
  export: "pencilSidecar",
  options: { root },
});

/** Every always-on sidecar, in registry order. */
const allDescriptors = (root: string) => [
  paintDescriptor(root),
  intentDescriptor(root),
  barDescriptor(root),
  pencilDescriptor(root),
];

/**
 * Deps for a test: an identity `resolveModule`, so the emitted `module` stays
 * the bare specifier (the real default resolves it to an absolute path — see
 * sidecars.ts — which needs the package on disk).
 */
const testDeps = () => ({
  resolveModule: (specifier: string) => specifier,
});

describe("resolveSidecars", () => {
  it("emits the always-on sidecars by default (no flags), registry order", () => {
    const out = resolveSidecars("/proj", { enable: [], disable: [] }, testDeps());
    expect(out).toEqual(allDescriptors("/proj"));
    // The exact contract shape, threading the root into options.
    expect(out[0]).toEqual({
      name: "paint",
      module: "@habemus-papadum/aiui-paint/sidecar",
      export: "paintSidecar",
      options: { root: "/proj" },
    });
  });

  it("disable turns off an always-on sidecar", () => {
    expect(resolveSidecars("/proj", { enable: [], disable: ["paint"] }, testDeps())).toEqual([
      intentDescriptor("/proj"),
      barDescriptor("/proj"),
      pencilDescriptor("/proj"),
    ]);
    expect(
      resolveSidecars("/proj", { enable: [], disable: ["intent", "bar", "pencil"] }, testDeps()),
    ).toEqual([paintDescriptor("/proj")]);
    expect(
      resolveSidecars(
        "/proj",
        { enable: [], disable: ["paint", "intent", "bar", "pencil"] },
        testDeps(),
      ),
    ).toEqual([]);
  });

  it("disable wins over an explicit enable of the same name", () => {
    expect(
      resolveSidecars(
        "/proj",
        { enable: ["paint"], disable: ["paint", "intent", "bar", "pencil"] },
        testDeps(),
      ),
    ).toEqual([]);
  });

  it("ignores enable names the CLI doesn't know how to construct", () => {
    expect(resolveSidecars("/proj", { enable: ["bogus"], disable: [] }, testDeps())).toEqual(
      allDescriptors("/proj"),
    );
  });

  it("a sidecar whose module fails to resolve is warned about and skipped", () => {
    const warnings: string[] = [];
    const out = resolveSidecars(
      "/proj",
      { enable: [], disable: [] },
      {
        resolveModule: (specifier: string) => {
          if (specifier.includes("intent-client")) {
            throw new Error("not installed"); // the --no-publish package, absent
          }
          return specifier;
        },
        log: (message) => warnings.push(message),
      },
    );
    expect(out).toEqual([
      paintDescriptor("/proj"),
      barDescriptor("/proj"),
      pencilDescriptor("/proj"),
    ]);
    expect(warnings.some((w) => w.includes('"intent"') && w.includes("failed to resolve"))).toBe(
      true,
    );
  });
});
