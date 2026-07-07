import { afterEach, describe, expect, it } from "vitest";
import { backendOrigin, backendUrl, setBackendOrigin } from "./backend-origin";

// backendOrigin reads globals; reset them so cases stay independent.
const g = globalThis as { __AIUI__?: { port?: number | string } };
afterEach(() => {
  setBackendOrigin(undefined);
  g.__AIUI__ = undefined;
});

describe("backendOrigin resolution order", () => {
  it("an explicit override wins over everything", () => {
    g.__AIUI__ = { port: 4321 };
    setBackendOrigin("http://example.test:9999");
    expect(backendOrigin()).toBe("http://example.test:9999");
  });

  it("falls back to the plugin-injected channel port", () => {
    g.__AIUI__ = { port: 4321 };
    expect(backendOrigin()).toBe("http://127.0.0.1:4321");
  });

  it("accepts a string port (the Vite plugin injects env-sourced values)", () => {
    g.__AIUI__ = { port: "5177" };
    expect(backendOrigin()).toBe("http://127.0.0.1:5177");
  });

  it("ignores an empty injected port and falls through to location.origin", () => {
    g.__AIUI__ = { port: "" };
    const location = (globalThis as { location?: { origin: string } }).location;
    expect(backendOrigin()).toBe(location?.origin ?? "");
  });

  it("backendUrl prepends the resolved origin to a route path", () => {
    g.__AIUI__ = { port: 4321 };
    expect(backendUrl("/__aiui_code/info")).toBe("http://127.0.0.1:4321/__aiui_code/info");
  });
});
