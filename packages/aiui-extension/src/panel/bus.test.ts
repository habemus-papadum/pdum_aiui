import { describe, expect, it } from "vitest";
import { INITIAL_BUS_STATE, reduceBusMessage } from "./bus";

describe("reduceBusMessage", () => {
  it("snapshot connects, adopts peers/slots/clientId", () => {
    const next = reduceBusMessage(INITIAL_BUS_STATE, {
      type: "snapshot",
      clientId: "c1",
      state: { armed: true },
      peers: [{ clientId: "c1" }, { clientId: "c2", role: "app" }],
    });
    expect(next.phase).toBe("connected");
    expect(next.clientId).toBe("c1");
    expect(next.peers).toHaveLength(2);
    expect(next.slots.armed).toBe(true);
  });

  it("peers replaces the list; set caches a slot; junk is ignored", () => {
    let state = reduceBusMessage(INITIAL_BUS_STATE, {
      type: "snapshot",
      clientId: "c1",
      state: {},
      peers: [],
    });
    state = reduceBusMessage(state, { v: 1, type: "peers", peers: [{ clientId: "c9" }] });
    expect(state.peers).toEqual([{ clientId: "c9" }]);
    state = reduceBusMessage(state, { v: 1, type: "set", slot: "preview", value: { text: "x" } });
    expect(state.slots.preview).toEqual({ text: "x" });
    expect(reduceBusMessage(state, "garbage")).toBe(state);
    expect(reduceBusMessage(state, { type: "unknown" })).toBe(state);
  });
});
