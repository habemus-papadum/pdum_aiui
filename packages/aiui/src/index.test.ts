import { describe, expect, it } from "vitest";
import { name } from "./index";

describe(name, () => {
  it("names the published package", () => {
    expect(name).toBe("@habemus-papadum/aiui");
  });
});
