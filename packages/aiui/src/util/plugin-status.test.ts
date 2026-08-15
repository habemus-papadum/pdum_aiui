import { describe, expect, it } from "vitest";
import { classifyInstalled, type PluginListEntry, versionRelation } from "./plugin-status";

const CWD = "/home/user/project";

/** A user-scope, enabled aiui entry — the healthy baseline to deviate from. */
const installed: PluginListEntry = {
  id: "aiui@pdum-aiui",
  version: "0.17.0+dev",
  scope: "user",
  enabled: true,
};

describe("classifyInstalled", () => {
  it("finds an enabled user-scope install", () => {
    expect(classifyInstalled([installed], CWD)).toEqual({ state: "enabled", entry: installed });
  });

  it("matches by plugin name, whatever marketplace delivered it", () => {
    const foreign = { ...installed, id: "aiui@someones-catalog" };
    expect(classifyInstalled([foreign], CWD)).toEqual({ state: "enabled", entry: foreign });
  });

  it("never matches other plugins (including aiui-prefixed names)", () => {
    const others: PluginListEntry[] = [
      { ...installed, id: "aiui-extras@pdum-aiui" },
      { ...installed, id: "swift-lsp@claude-plugins-official" },
    ];
    expect(classifyInstalled(others, CWD)).toEqual({ state: "absent" });
  });

  it("counts a project-scope install only for its own project", () => {
    const here = { ...installed, scope: "project", projectPath: CWD };
    const elsewhere = { ...installed, scope: "project", projectPath: "/somewhere/else" };
    expect(classifyInstalled([here], CWD)).toEqual({ state: "enabled", entry: here });
    expect(classifyInstalled([elsewhere], CWD)).toEqual({ state: "absent" });
  });

  it("reports disabled when every applicable install is disabled", () => {
    const disabled = { ...installed, enabled: false };
    expect(classifyInstalled([disabled], CWD)).toEqual({ state: "disabled", entry: disabled });
  });

  it("prefers any enabled entry over a disabled one", () => {
    const disabled = { ...installed, enabled: false, scope: "project", projectPath: CWD };
    expect(classifyInstalled([disabled, installed], CWD)).toEqual({
      state: "enabled",
      entry: installed,
    });
  });

  it("is absent on an empty list", () => {
    expect(classifyInstalled([], CWD)).toEqual({ state: "absent" });
  });
});

describe("versionRelation", () => {
  it("compares semver cores, ignoring the lockstep +dev marker", () => {
    expect(versionRelation("0.17.0+dev", "0.17.0")).toBe("current");
    expect(versionRelation("0.17.0", "0.17.0+dev")).toBe("current");
  });

  it("flags an older plugin as stale across every position", () => {
    expect(versionRelation("0.16.9+dev", "0.17.0")).toBe("stale");
    expect(versionRelation("0.17.0", "0.17.1")).toBe("stale");
    expect(versionRelation("0.17.2", "1.0.0")).toBe("stale");
  });

  it("flags a newer plugin as newer", () => {
    expect(versionRelation("0.18.0+dev", "0.17.0")).toBe("newer");
  });

  it("is unknown when either side has no semver core", () => {
    expect(versionRelation("unknown", "0.17.0")).toBe("unknown");
    expect(versionRelation(undefined, "0.17.0")).toBe("unknown");
    expect(versionRelation("0.17.0", "0.0.0+dev")).toBe("newer"); // tsx fallback CLI version still compares
  });
});
