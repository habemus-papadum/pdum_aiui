import { describe, expect, it } from "vitest";
import { sanitizeHostKey } from "./session-browser";

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
