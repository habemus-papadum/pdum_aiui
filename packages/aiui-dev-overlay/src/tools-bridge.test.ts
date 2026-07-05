// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { getInstrumentation } from "./instrumentation";
import {
  type BridgeTool,
  canonicalToolsHash,
  installToolsBridge,
  type ToolsBridgeOptions,
  type ToolsSocketFactory,
  type ToolsSocketLike,
} from "./tools-bridge";

/**
 * Install with the capability probe stubbed to "channel supports /tools",
 * synchronously — so sockets exist as soon as the call returns, like the old
 * dial-immediately behavior the tests were written against.
 */
const install = (opts: ToolsBridgeOptions) => installToolsBridge({ probe: () => "tools", ...opts });

/** A scriptable fake `/tools` socket: records sent JSON, lets the test drive events. */
function fakeToolsSocket() {
  const sent: string[] = [];
  const listeners = new Map<string, Array<(event: unknown) => void>>();
  const emit = (type: string, event: unknown) => {
    for (const fn of listeners.get(type) ?? []) {
      fn(event);
    }
  };
  const socket: ToolsSocketLike = {
    send: (data) => sent.push(data),
    close: () => emit("close", {}),
    addEventListener: (type, listener) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener as (event: unknown) => void]);
    },
  };
  return { socket, sent, emit };
}

/** A factory that hands out fresh sockets and keeps them for inspection. */
function socketFactory() {
  const sockets: Array<ReturnType<typeof fakeToolsSocket>> = [];
  const factory: ToolsSocketFactory = () => {
    const s = fakeToolsSocket();
    sockets.push(s);
    return s.socket;
  };
  return { factory, sockets };
}

/** Parse the register/result frames a socket sent, by type. */
const framesOfType = (sent: string[], type: string) =>
  sent.map((s) => JSON.parse(s)).filter((m) => m.type === type);

const flush = () => new Promise((r) => setTimeout(r, 0));

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
  window.__AIUI__ = undefined;
  vi.useRealTimers();
});

describe("installToolsBridge", () => {
  it("no-ops without a resolvable channel port", () => {
    window.__AIUI__ = { v: 1, frames: [] }; // no port
    const { factory, sockets } = socketFactory();
    dispose = install({ socketFactory: factory });
    expect(sockets).toHaveLength(0);
    expect(getInstrumentation()?.tools).toBeUndefined();
  });

  it("installs the API, reads the injected port, and fires the ready event", () => {
    window.__AIUI__ = { v: 1, frames: [], port: 5123 };
    const readyFired = vi.fn();
    document.addEventListener("aiui:tools-ready", readyFired);
    const { factory } = socketFactory();
    dispose = install({ socketFactory: factory });
    expect(typeof getInstrumentation()?.tools?.register).toBe("function");
    expect(readyFired).toHaveBeenCalledOnce();
  });

  it("is idempotent — a second install returns the first disposer and installs one socket", () => {
    window.__AIUI__ = { v: 1, frames: [], port: 5123 };
    const { factory, sockets } = socketFactory();
    dispose = install({ socketFactory: factory });
    const second = install({ socketFactory: factory });
    expect(second).toBe(dispose);
    expect(sockets).toHaveLength(1);
  });

  it("sends a register frame with a stable content hash", () => {
    window.__AIUI__ = { v: 1, frames: [], port: 5123 };
    const { factory, sockets } = socketFactory();
    dispose = install({ port: 5123, socketFactory: factory });
    const s = sockets[0];
    s.emit("open", {});

    const tools: BridgeTool[] = [
      {
        name: "set-params",
        description: "set params",
        inputSchema: { type: "object" },
        run: () => 1,
      },
    ];
    window.__AIUI__?.tools?.register("morpho", tools);
    // Re-register the same set (as a reload would): the hash must not change.
    window.__AIUI__?.tools?.register("morpho", tools);

    const regs = framesOfType(s.sent, "register");
    expect(regs).toHaveLength(2);
    expect(regs[0].ns).toBe("morpho");
    expect(regs[0].tools).toEqual([
      { name: "set-params", description: "set params", inputSchema: { type: "object" } },
    ]);
    expect(regs[0].hash).toBe(
      canonicalToolsHash([
        { name: "set-params", description: "set params", inputSchema: { type: "object" } },
      ]),
    );
    expect(regs[1].hash).toBe(regs[0].hash);
  });

  it("routes an incoming call to the newest run after re-registration", async () => {
    window.__AIUI__ = { v: 1, frames: [], port: 5123 };
    const { factory, sockets } = socketFactory();
    dispose = install({ port: 5123, socketFactory: factory });
    const s = sockets[0];
    s.emit("open", {});

    window.__AIUI__?.tools?.register("morpho", [{ name: "t", description: "v1", run: () => "v1" }]);
    window.__AIUI__?.tools?.register("morpho", [{ name: "t", description: "v2", run: () => "v2" }]);

    s.emit("message", {
      data: JSON.stringify({ v: 1, type: "call", callId: "c1", ns: "morpho", name: "t" }),
    });
    await flush();

    const results = framesOfType(s.sent, "result");
    expect(results).toContainEqual({ v: 1, type: "result", callId: "c1", ok: true, value: "v2" });
  });

  it("passes args through and JSON-serializes the value", async () => {
    window.__AIUI__ = { v: 1, frames: [], port: 5123 };
    const { factory, sockets } = socketFactory();
    dispose = install({ port: 5123, socketFactory: factory });
    const s = sockets[0];
    s.emit("open", {});

    window.__AIUI__?.tools?.register("morpho", [
      { name: "echo", description: "echo", run: async (args) => ({ echoed: args }) },
    ]);
    s.emit("message", {
      data: JSON.stringify({
        v: 1,
        type: "call",
        callId: "c2",
        ns: "morpho",
        name: "echo",
        args: { a: 1 },
      }),
    });
    await flush();

    expect(framesOfType(s.sent, "result")).toContainEqual({
      v: 1,
      type: "result",
      callId: "c2",
      ok: true,
      value: { echoed: { a: 1 } },
    });
  });

  it("maps a thrown error and an unknown tool to ok:false results", async () => {
    window.__AIUI__ = { v: 1, frames: [], port: 5123 };
    const { factory, sockets } = socketFactory();
    dispose = install({ port: 5123, socketFactory: factory });
    const s = sockets[0];
    s.emit("open", {});

    window.__AIUI__?.tools?.register("morpho", [
      {
        name: "boom",
        description: "explode",
        run: () => {
          throw new Error("kaboom");
        },
      },
    ]);
    s.emit("message", {
      data: JSON.stringify({ v: 1, type: "call", callId: "c3", ns: "morpho", name: "boom" }),
    });
    s.emit("message", {
      data: JSON.stringify({ v: 1, type: "call", callId: "c4", ns: "morpho", name: "ghost" }),
    });
    await flush();

    const results = framesOfType(s.sent, "result");
    expect(results.find((r) => r.callId === "c3")).toEqual({
      v: 1,
      type: "result",
      callId: "c3",
      ok: false,
      error: "kaboom",
    });
    expect(results.find((r) => r.callId === "c4")).toMatchObject({ callId: "c4", ok: false });
    expect(results.find((r) => r.callId === "c4").error).toContain("ghost");
  });

  it("reconnects after a drop and re-declares every registration", () => {
    vi.useFakeTimers();
    window.__AIUI__ = { v: 1, frames: [], port: 5123 };
    const { factory, sockets } = socketFactory();
    dispose = install({ port: 5123, socketFactory: factory });
    sockets[0].emit("open", {});
    window.__AIUI__?.tools?.register("morpho", [{ name: "t", description: "d", run: () => 1 }]);
    expect(framesOfType(sockets[0].sent, "register")).toHaveLength(1);

    // Drop the connection; after the backoff a new socket is created…
    sockets[0].emit("close", {});
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(3000);
    expect(sockets).toHaveLength(2);

    // …and on open it re-declares what was registered, without a re-register call.
    sockets[1].emit("open", {});
    expect(framesOfType(sockets[1].sent, "register")).toHaveLength(1);
    expect(framesOfType(sockets[1].sent, "register")[0].ns).toBe("morpho");
  });

  it("stays dormant against an older channel: API installed, socket never dialed", () => {
    window.__AIUI__ = { v: 1, frames: [], port: 5123 };
    const { factory, sockets } = socketFactory();
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    dispose = installToolsBridge({ port: 5123, socketFactory: factory, probe: () => "no-tools" });
    // The page-facing API still exists — toolkits register locally as before.
    window.__AIUI__?.tools?.register("morpho", [{ name: "t", description: "d", run: () => 1 }]);
    expect(sockets).toHaveLength(0);
    expect(debug).toHaveBeenCalledOnce();
    debug.mockRestore();
  });

  it("bounds unreachable-probe episodes instead of retrying forever", () => {
    vi.useFakeTimers();
    window.__AIUI__ = { v: 1, frames: [], port: 5123 };
    const { factory, sockets } = socketFactory();
    const probe = vi.fn<() => "unreachable">(() => "unreachable");
    dispose = installToolsBridge({ port: 5123, socketFactory: factory, probe });
    expect(probe).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(3000);
    expect(probe).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(3000);
    expect(probe).toHaveBeenCalledTimes(3);
    // Episode exhausted: no further probes, and the socket was never dialed.
    vi.advanceTimersByTime(60_000);
    expect(probe).toHaveBeenCalledTimes(3);
    expect(sockets).toHaveLength(0);
  });

  it("stops sending and clears the global after dispose", () => {
    window.__AIUI__ = { v: 1, frames: [], port: 5123 };
    const { factory, sockets } = socketFactory();
    const d = install({ port: 5123, socketFactory: factory });
    sockets[0].emit("open", {});
    d();
    expect(getInstrumentation()?.tools).toBeUndefined();
    // No throw, and nothing is sent for a call that arrives after teardown.
    sockets[0].emit("message", {
      data: JSON.stringify({ v: 1, type: "call", callId: "x", ns: "morpho", name: "t" }),
    });
    dispose = undefined;
  });
});
