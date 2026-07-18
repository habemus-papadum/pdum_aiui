import { afterEach, describe, expect, it, vi } from "vitest";
import { asBusPublish, asContributedSelection, resolveChannelPort } from "./session";

/** Stub `location` with just the fields resolveChannelPort reads. */
const stubLocation = (fields: { search?: string; port?: string }): void => {
  vi.stubGlobal("location", { search: fields.search ?? "", port: fields.port ?? "" });
};

describe("resolveChannelPort", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("prefers an explicit argument over everything", () => {
    stubLocation({ search: "?channel=5555", port: "3000" });
    vi.stubEnv("VITE_AIUI_PORT", "49317");
    expect(resolveChannelPort(1234)).toBe(1234);
  });

  it("takes ?channel= over the injected env and the origin", () => {
    stubLocation({ search: "?channel=5555", port: "3000" });
    vi.stubEnv("VITE_AIUI_PORT", "49317");
    expect(resolveChannelPort()).toBe(5555);
  });

  it("takes VITE_AIUI_PORT over same-origin location.port (the dev-launcher path)", () => {
    // location.port is Vite's here; without the env win the page would probe
    // Vite, fail, and drop to the fake tier. The env is what fixes that.
    stubLocation({ search: "", port: "3000" });
    vi.stubEnv("VITE_AIUI_PORT", "49317");
    expect(resolveChannelPort()).toBe(49317);
  });

  it("falls back to same-origin location.port when the channel served the page", () => {
    stubLocation({ search: "", port: "49317" });
    expect(resolveChannelPort()).toBe(49317);
  });

  it("returns undefined with no origin port and nothing injected", () => {
    stubLocation({ search: "", port: "" });
    expect(resolveChannelPort()).toBeUndefined();
  });

  it("ignores a non-numeric ?channel / env value", () => {
    stubLocation({ search: "?channel=abc", port: "" });
    vi.stubEnv("VITE_AIUI_PORT", "not-a-port");
    expect(resolveChannelPort()).toBeUndefined();
  });
});

describe("asBusPublish", () => {
  it("narrows a publish frame, keeping payload and from", () => {
    expect(
      asBusPublish({
        v: 1,
        type: "publish",
        topic: "contribution",
        payload: { x: 1 },
        from: "server",
      }),
    ).toEqual({ topic: "contribution", payload: { x: 1 }, from: "server" });
  });

  it("rejects non-publish frames and malformed shapes", () => {
    expect(asBusPublish({ type: "snapshot", peers: [] })).toBeUndefined();
    expect(asBusPublish({ type: "publish" })).toBeUndefined(); // no topic
    expect(asBusPublish("publish")).toBeUndefined();
    expect(asBusPublish(null)).toBeUndefined();
  });
});

describe("asContributedSelection (the VS Code send-selection wire)", () => {
  it("accepts the extension's SelectionContribution shape", () => {
    // The exact payload aiui-vscode's selectionToContribution builds.
    const sel = asContributedSelection({
      topic: "contribution",
      payload: {
        kind: "selection",
        text: "const x = 1;",
        sourceLoc: "src/a.ts:5:1",
        url: "vscode://file/repo/src/a.ts:5:1",
        role: "vscode",
        lines: 1,
      },
    });
    expect(sel).toEqual({
      text: "const x = 1;",
      sourceLoc: "src/a.ts:5:1",
      url: "vscode://file/repo/src/a.ts:5:1",
      lines: 1,
    });
  });

  it("keeps only well-typed enrichment fields", () => {
    const sel = asContributedSelection({
      topic: "contribution",
      payload: { kind: "selection", text: "x", sourceLoc: 7, lines: "3" },
    });
    expect(sel).toEqual({ text: "x" });
  });

  it("yields undefined for other topics, other kinds, and empty selections", () => {
    expect(
      asContributedSelection({ topic: "other", payload: { kind: "selection", text: "x" } }),
    ).toBeUndefined();
    expect(
      asContributedSelection({ topic: "contribution", payload: { kind: "note", text: "x" } }),
    ).toBeUndefined();
    expect(
      asContributedSelection({ topic: "contribution", payload: { kind: "selection", text: "" } }),
    ).toBeUndefined();
    expect(asContributedSelection({ topic: "contribution" })).toBeUndefined();
  });
});
