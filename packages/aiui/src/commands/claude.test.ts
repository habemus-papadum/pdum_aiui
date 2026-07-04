import { afterEach, describe, expect, it } from "vitest";
import { isInteractiveSession } from "./claude";

describe("isInteractiveSession", () => {
  const origIn = process.stdin.isTTY;
  const origOut = process.stdout.isTTY;
  afterEach(() => {
    process.stdin.isTTY = origIn;
    process.stdout.isTTY = origOut;
  });
  function setTty(value: boolean) {
    process.stdin.isTTY = value;
    process.stdout.isTTY = value;
  }

  it("is true for an interactive TTY with no print flag", () => {
    setTty(true);
    expect(isInteractiveSession(["--model", "haiku"])).toBe(true);
    expect(isInteractiveSession([])).toBe(true);
  });

  it("is false in print mode (-p / --print)", () => {
    setTty(true);
    expect(isInteractiveSession(["-p", "hello"])).toBe(false);
    expect(isInteractiveSession(["--print"])).toBe(false);
  });

  it("is false when either end is not a TTY", () => {
    setTty(false);
    expect(isInteractiveSession([])).toBe(false);
  });
});
