import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { remoteProfileDir, sanitizeHostKey } from "./session-browser";

let prevCache: string | undefined;

beforeEach(() => {
  prevCache = process.env.AIUI_CACHE;
  process.env.AIUI_CACHE = "/user-cache";
});

afterEach(() => {
  if (prevCache === undefined) delete process.env.AIUI_CACHE;
  else process.env.AIUI_CACHE = prevCache;
});

describe("sanitizeHostKey", () => {
  it("drops the user part and keeps hostnames readable", () => {
    expect(sanitizeHostKey("nehal@dev.example.com")).toBe("dev.example.com");
    expect(sanitizeHostKey("dev-box")).toBe("dev-box");
  });

  it("makes odd targets filesystem-safe", () => {
    expect(sanitizeHostKey("user@[fe80::1]")).toBe("-fe80--1-");
    expect(sanitizeHostKey("@")).toBe("remote");
  });
});

describe("remoteProfileDir", () => {
  it("keys the user-cache profile by host, or by an explicit profile name", () => {
    expect(remoteProfileDir("nehal@dev-box")).toBe(
      join("/user-cache", "browser-profiles", "dev-box"),
    );
    expect(remoteProfileDir("nehal@dev-box", "work")).toBe(
      join("/user-cache", "browser-profiles", "work"),
    );
  });
});
