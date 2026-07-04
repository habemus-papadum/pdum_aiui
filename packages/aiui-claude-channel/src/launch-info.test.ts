import { describe, expect, it } from "vitest";
import { parseLaunchInfo } from "./launch-info";

describe("parseLaunchInfo", () => {
  it("parses a JSON object envelope", () => {
    const info = parseLaunchInfo(
      JSON.stringify({
        launcher: "aiui claude",
        chromeDevtools: { enabled: true, connection: "attach", browserUrl: "http://127.0.0.1:1" },
      }),
    );
    expect(info?.launcher).toBe("aiui claude");
    expect(info?.chromeDevtools?.connection).toBe("attach");
  });

  it("returns undefined for anything that isn't a JSON object", () => {
    expect(parseLaunchInfo("not json")).toBeUndefined();
    expect(parseLaunchInfo('"a string"')).toBeUndefined();
    expect(parseLaunchInfo("[1,2]")).toBeUndefined();
    expect(parseLaunchInfo("null")).toBeUndefined();
  });
});
