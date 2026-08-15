/**
 * path-binding.test.ts — the pure slide↔path mapping, across the hosts a
 * deck really has: standalone at "/", gallery dev at "/<slug>", published at
 * "/aiui/<slug>".
 */
import { describe, expect, it } from "vitest";
import { pathForSlide, slideFromPath } from "./path-binding";

const ids = ["title", "involute", "mesh"] as const;

describe("slideFromPath", () => {
  it("maps the bare base to 0 and id tails to their index", () => {
    expect(slideFromPath("/gear-talk", "/gear-talk", ids)).toBe(0);
    expect(slideFromPath("/gear-talk/", "/gear-talk", ids)).toBe(0);
    expect(slideFromPath("/gear-talk/involute", "/gear-talk", ids)).toBe(1);
    expect(slideFromPath("/aiui/gear-talk/mesh", "/aiui/gear-talk", ids)).toBe(2);
  });

  it("accepts a bare 1-based number, clamped", () => {
    expect(slideFromPath("/gear-talk/2", "/gear-talk", ids)).toBe(1);
    expect(slideFromPath("/gear-talk/99", "/gear-talk", ids)).toBe(2);
    expect(slideFromPath("/gear-talk/0", "/gear-talk", ids)).toBe(0);
  });

  it("treats an unknown tail as the title, and a foreign path as not-ours", () => {
    expect(slideFromPath("/gear-talk/nonsense", "/gear-talk", ids)).toBe(0);
    expect(slideFromPath("/gears", "/gear-talk", ids)).toBe(-1);
    expect(slideFromPath("/gear-talkers", "/gear-talk", ids)).toBe(-1);
  });

  it("works at the root base (standalone dev)", () => {
    expect(slideFromPath("/", "", ids)).toBe(0);
    expect(slideFromPath("/mesh", "", ids)).toBe(2);
    expect(slideFromPath("/", "/", ids)).toBe(0);
  });
});

describe("pathForSlide", () => {
  it("slide 0 is the bare base; others carry the id", () => {
    expect(pathForSlide("/gear-talk", ids, 0)).toBe("/gear-talk");
    expect(pathForSlide("/gear-talk", ids, 2)).toBe("/gear-talk/mesh");
    expect(pathForSlide("/aiui/gear-talk", ids, 1)).toBe("/aiui/gear-talk/involute");
    expect(pathForSlide("", ids, 0)).toBe("/");
    expect(pathForSlide("", ids, 1)).toBe("/involute");
  });

  it("round-trips with slideFromPath", () => {
    for (const base of ["", "/gear-talk", "/aiui/gear-talk"]) {
      for (let i = 0; i < ids.length; i++) {
        expect(slideFromPath(pathForSlide(base, ids, i), base, ids)).toBe(i);
      }
    }
  });
});
