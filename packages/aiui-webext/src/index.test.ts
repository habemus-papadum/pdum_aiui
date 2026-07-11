import { describe, expect, it } from "vitest";
import { isRelayEnvelope, PANE_STYLES } from "./index";

describe("@habemus-papadum/aiui-webext barrel", () => {
  it("exposes the runtime surface", () => {
    expect(typeof isRelayEnvelope).toBe("function");
    expect(PANE_STYLES).toContain(".wx-pane");
  });
});
