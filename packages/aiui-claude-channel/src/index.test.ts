import { describe, expect, it } from "vitest";
import { createChannelServer, defaultFormats, name } from "./index";

describe(name, () => {
  it("re-exports the channel factory and the built-in formats", () => {
    expect(createChannelServer("1.2.3")).toBeTruthy();
    expect([...defaultFormats().keys()].sort()).toEqual(["intent-v1", "text-concat"]);
  });
});
