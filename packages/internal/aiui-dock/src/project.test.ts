import { describe, expect, it } from "vitest";
import { activeNamespaces } from "./project";

describe("activeNamespaces", () => {
  it("keeps every kit that is not parked — the gallery's off-route pages stay out", () => {
    expect(
      activeNamespaces([
        { ns: "seismos", active: true },
        { ns: "aztec", active: false },
        { ns: "legacy" }, // predates the activity bit: active
      ]),
    ).toEqual(["seismos", "legacy"]);
    expect(activeNamespaces([])).toEqual([]);
  });
});
