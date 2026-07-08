import { describe, expect, it } from "vitest";
import {
  isPortTakenError,
  portTakenHint,
  resolveWorkbenchPorts,
  WORKBENCH_PORT_DEFAULTS,
  WORKBENCH_PORT_ENV,
} from "./ports";

describe("resolveWorkbenchPorts", () => {
  it("defaults to the fixed 49222/49223 layout", () => {
    expect(resolveWorkbenchPorts({})).toEqual({ workbench: 49222, channel: 49223 });
    expect(resolveWorkbenchPorts({})).toEqual(WORKBENCH_PORT_DEFAULTS);
  });

  it("lets each WORKBENCH_* var override its own port independently", () => {
    expect(resolveWorkbenchPorts({ WORKBENCH_CHANNEL_PORT: "50001" })).toEqual({
      workbench: 49222,
      channel: 50001,
    });
    expect(
      resolveWorkbenchPorts({
        WORKBENCH_PORT: "50000",
        WORKBENCH_CHANNEL_PORT: "50001",
      }),
    ).toEqual({ workbench: 50000, channel: 50001 });
  });

  it("ignores empty-string overrides (unset-ish env)", () => {
    expect(resolveWorkbenchPorts({ WORKBENCH_PORT: "" })).toEqual(WORKBENCH_PORT_DEFAULTS);
  });

  it("throws (naming the var) on a set-but-invalid override instead of falling back", () => {
    for (const bad of ["abc", "0", "65536", "-1", "49222.5", "0x10", " "]) {
      expect(() => resolveWorkbenchPorts({ WORKBENCH_CHANNEL_PORT: bad })).toThrow(
        /WORKBENCH_CHANNEL_PORT.*integer between 1 and 65535/,
      );
    }
  });

  it("does not read anything but the two documented vars", () => {
    expect(resolveWorkbenchPorts({ WORKBENCH_RECORD: "1", PORT: "9999" })).toEqual(
      WORKBENCH_PORT_DEFAULTS,
    );
  });
});

describe("portTakenHint", () => {
  it("names the server, the port, and the env override", () => {
    const hint = portTakenHint("channel", WORKBENCH_PORT_DEFAULTS);
    expect(hint).toContain("debug channel port 49223");
    expect(hint).toContain("is another workbench running?");
    expect(hint).toContain(`${WORKBENCH_PORT_ENV.channel}=<port>`);
  });

  it("reflects overridden ports, not the defaults", () => {
    const ports = resolveWorkbenchPorts({ WORKBENCH_PORT: "50000" });
    expect(portTakenHint("workbench", ports)).toContain("workbench UI port 50000");
  });
});

describe("isPortTakenError", () => {
  it("matches Node's EADDRINUSE and Vite's strictPort message, nothing else", () => {
    expect(isPortTakenError(Object.assign(new Error("listen"), { code: "EADDRINUSE" }))).toBe(true);
    expect(isPortTakenError(new Error("Port 49223 is already in use"))).toBe(true);
    expect(isPortTakenError(new Error("connect ECONNREFUSED"))).toBe(false);
    expect(isPortTakenError(undefined)).toBe(false);
    expect(isPortTakenError("already in use")).toBe(false); // not an Error
  });
});
