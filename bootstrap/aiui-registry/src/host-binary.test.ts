import { describe, expect, it } from "vitest";
import { hostBinaryPackage, resolveHostBinary } from "./host-binary.ts";

describe("hostBinaryPackage", () => {
  it("maps supported platform/arch pairs to package names", () => {
    expect(hostBinaryPackage("darwin", "arm64")).toBe(
      "@habemus-papadum/aiui-registry-host-darwin-arm64",
    );
    expect(hostBinaryPackage("linux", "x64")).toBe("@habemus-papadum/aiui-registry-host-linux-x64");
  });
  it("returns undefined for unsupported combinations", () => {
    expect(hostBinaryPackage("win32", "x64")).toBeUndefined();
    expect(hostBinaryPackage("linux", "ia32")).toBeUndefined();
  });
});

describe("resolveHostBinary", () => {
  it("joins the binary name onto the resolved platform package", () => {
    const path = resolveHostBinary({
      platform: "linux",
      arch: "x64",
      resolvePath: (spec) => `/nm/${spec}`,
    });
    expect(path).toBe("/nm/@habemus-papadum/aiui-registry-host-linux-x64/aiui-registry-host");
  });
  it("returns undefined when the platform package is not installed", () => {
    const path = resolveHostBinary({
      platform: "linux",
      arch: "x64",
      resolvePath: () => {
        throw new Error("not found");
      },
    });
    expect(path).toBeUndefined();
  });
  it("returns undefined on unsupported platforms without resolving", () => {
    let called = 0;
    const path = resolveHostBinary({
      platform: "win32",
      arch: "x64",
      resolvePath: () => {
        called++;
        return "/x";
      },
    });
    expect(path).toBeUndefined();
    expect(called).toBe(0);
  });
});
