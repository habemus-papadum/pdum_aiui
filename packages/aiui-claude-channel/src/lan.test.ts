import { describe, expect, it } from "vitest";
import { listLanInterfaces } from "./lan";

describe("listLanInterfaces", () => {
  it("keeps only non-internal IPv4, with the interface name", () => {
    const ifaces = {
      lo0: [
        { address: "127.0.0.1", family: "IPv4", internal: true } as never,
        { address: "::1", family: "IPv6", internal: true } as never,
      ],
      en0: [
        { address: "192.168.1.42", family: "IPv4", internal: false } as never,
        { address: "fe80::1", family: "IPv6", internal: false } as never,
      ],
      en1: [{ address: "10.0.0.7", family: "IPv4", internal: false } as never],
    };
    expect(listLanInterfaces(ifaces)).toEqual([
      { name: "en0", address: "192.168.1.42" },
      { name: "en1", address: "10.0.0.7" },
    ]);
  });

  it("returns an empty list when nothing qualifies (loopback-only / offline)", () => {
    const ifaces = {
      lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true } as never],
    };
    expect(listLanInterfaces(ifaces)).toEqual([]);
  });

  it("tolerates an interface with no addresses", () => {
    expect(listLanInterfaces({ en0: undefined })).toEqual([]);
  });
});
