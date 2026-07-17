import { describe, expect, it } from "vitest";
import { boundInterfaces } from "./pencil-url";

describe("boundInterfaces", () => {
  it("offers only loopback for a loopback-bound channel", () => {
    for (const bind of ["127.0.0.1", undefined]) {
      const ifaces = boundInterfaces(bind);
      expect(ifaces).toEqual([{ name: "loopback", address: "127.0.0.1" }]);
    }
  });

  it("offers the machine's non-internal IPv4 interfaces (plus loopback last) when host-bound", () => {
    const ifaces = boundInterfaces("0.0.0.0");
    // Loopback is always the LAST option (on-machine testing fallback).
    expect(ifaces.at(-1)).toEqual({ name: "loopback", address: "127.0.0.1" });
    // Every non-loopback entry is a concrete IPv4 with an interface name.
    for (const iface of ifaces.slice(0, -1)) {
      expect(iface.name).not.toBe("");
      expect(iface.address).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
      expect(iface.address).not.toBe("127.0.0.1");
    }
  });
});
