import { describe, expect, it } from "vitest";
import { parameterList } from "./index";

describe("parameterList", () => {
  it("names the arguments, required bare and optional marked, from the JSON schema", () => {
    expect(
      parameterList({
        type: "object",
        properties: { sql: { type: "string" }, limit: { type: "number" }, format: {} },
        required: ["sql"],
      }),
    ).toBe("sql, limit?, format?");
  });

  it("is empty for a tool that takes nothing", () => {
    expect(parameterList({ type: "object", properties: {} })).toBe("");
    expect(parameterList({})).toBe("");
  });
});
