import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveChannelPort } from "./session";

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
