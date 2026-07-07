// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { getInstrumentation } from "./instrumentation";
import {
  installSessionBus,
  type SessionBusOptions,
  type SessionSocketFactory,
  type SessionSocketLike,
} from "./session-bus";

/** Install with the capability probe stubbed to "session", synchronously. */
const install = (opts: SessionBusOptions) => installSessionBus({ probe: () => "session", ...opts });

/** The installed bus API, asserted present (the tests always install one first). */
function busApi() {
  const bus = getInstrumentation()?.session;
  if (!bus) throw new Error("session bus not installed");
  return bus;
}

/** A scriptable fake `/session` socket: records sent JSON, drives events. */
function fakeSessionSocket() {
  const sent: string[] = [];
  const listeners = new Map<string, Array<(event: unknown) => void>>();
  const emit = (type: string, event: unknown) => {
    for (const fn of listeners.get(type) ?? []) {
      fn(event);
    }
  };
  const socket: SessionSocketLike = {
    send: (data) => sent.push(data),
    close: () => emit("close", {}),
    addEventListener: (type, listener) => {
      listeners.set(type, [...(listeners.get(type) ?? []), listener as (event: unknown) => void]);
    },
  };
  const push = (message: unknown) => emit("message", { data: JSON.stringify(message) });
  return { socket, sent, emit, push };
}

function socketFactory() {
  const sockets: Array<ReturnType<typeof fakeSessionSocket>> = [];
  const factory: SessionSocketFactory = () => {
    const s = fakeSessionSocket();
    sockets.push(s);
    return s.socket;
  };
  return { factory, sockets };
}

const framesOfType = (sent: string[], type: string) =>
  sent.map((s) => JSON.parse(s)).filter((m) => m.type === type);

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
  window.__AIUI__ = undefined;
  vi.useRealTimers();
});

describe("installSessionBus", () => {
  it("no-ops without a resolvable channel port", () => {
    window.__AIUI__ = { v: 1, frames: [] };
    const { factory, sockets } = socketFactory();
    dispose = install({ socketFactory: factory });
    expect(sockets).toHaveLength(0);
    expect(getInstrumentation()?.session).toBeUndefined();
  });

  it("installs the API and sends a hello with the role on open", () => {
    window.__AIUI__ = { v: 1, frames: [], port: 5123 };
    const { factory, sockets } = socketFactory();
    dispose = install({ socketFactory: factory, role: "code" });
    expect(typeof getInstrumentation()?.session?.set).toBe("function");
    sockets[0].emit("open", {});
    const hello = framesOfType(sockets[0].sent, "hello")[0];
    expect(hello).toMatchObject({ type: "hello", role: "code" });
  });

  it("is idempotent — a second install returns the first disposer, one socket", () => {
    window.__AIUI__ = { v: 1, frames: [], port: 5123 };
    const { factory, sockets } = socketFactory();
    dispose = install({ socketFactory: factory });
    const second = install({ socketFactory: factory });
    expect(second).toBe(dispose);
    expect(sockets).toHaveLength(1);
  });

  it("caches the snapshot, fires slot + ready + peers handlers", () => {
    window.__AIUI__ = { v: 1, frames: [], port: 5123 };
    const { factory, sockets } = socketFactory();
    dispose = install({ socketFactory: factory, role: "app" });
    const bus = busApi();

    const armedSeen: unknown[] = [];
    bus.on("armed", (v) => armedSeen.push(v));
    const ready = vi.fn();
    bus.onReady(ready);
    const peersSeen: unknown[] = [];
    bus.onPeers((p) => peersSeen.push(p));

    sockets[0].emit("open", {});
    sockets[0].push({
      v: 1,
      type: "snapshot",
      clientId: "me",
      state: { armed: true },
      peers: [
        { clientId: "me", role: "app" },
        { clientId: "other", role: "code" },
      ],
    });

    expect(armedSeen).toEqual([true]); // snapshot replayed through the handler
    expect(bus.get("armed")).toBe(true);
    expect(ready).toHaveBeenCalledOnce();
    expect(bus.ready()).toBe(true);
    expect(bus.clientId()).toBe("me");
    // peers() excludes self
    expect(bus.peers().map((p) => p.clientId)).toEqual(["other"]);
    expect((peersSeen[0] as unknown[]).length).toBe(2);
  });

  it("delivers set changes and transient publishes to handlers", () => {
    window.__AIUI__ = { v: 1, frames: [], port: 5123 };
    const { factory, sockets } = socketFactory();
    dispose = install({ socketFactory: factory });
    const bus = busApi();
    sockets[0].emit("open", {});

    const previews: unknown[] = [];
    bus.on("preview", (v) => previews.push(v));
    const contribs: unknown[] = [];
    bus.onPublish("contribution", (p) => contribs.push(p));

    sockets[0].push({ v: 1, type: "set", slot: "preview", value: { text: "hi" }, from: "x" });
    sockets[0].push({
      v: 1,
      type: "publish",
      topic: "contribution",
      payload: { kind: "selection", text: "Vec3" },
      from: "code1",
    });

    expect(previews).toEqual([{ text: "hi" }]);
    expect(contribs).toEqual([{ kind: "selection", text: "Vec3" }]);
  });

  it("set() and publish() write the right frames", () => {
    window.__AIUI__ = { v: 1, frames: [], port: 5123 };
    const { factory, sockets } = socketFactory();
    dispose = install({ socketFactory: factory });
    const bus = busApi();
    sockets[0].emit("open", {});

    bus.set("armed", true);
    bus.publish("contribution", { kind: "text", text: "hello" });

    expect(framesOfType(sockets[0].sent, "set")[0]).toMatchObject({ slot: "armed", value: true });
    expect(framesOfType(sockets[0].sent, "publish")[0]).toMatchObject({
      topic: "contribution",
      payload: { kind: "text", text: "hello" },
    });
    // read-your-writes cache
    expect(bus.get("armed")).toBe(true);
  });
});
