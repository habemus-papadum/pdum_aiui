import { describe, expect, it } from "vitest";
import { SessionHub, type SessionServerMessage } from "./session-hub";

/** A fake connection that records what the hub pushed to it. */
function fakeConn() {
  const received: SessionServerMessage[] = [];
  return { received, send: (m: SessionServerMessage) => received.push(m) };
}

/** Deterministic ids so assertions can name clients. */
function seqIds() {
  let n = 0;
  return () => `c${++n}`;
}

describe("SessionHub", () => {
  it("hands a joiner a snapshot of the cached state + peers", () => {
    const hub = new SessionHub({ newId: seqIds(), log: () => {} });
    const a = fakeConn();
    const idA = hub.addConnection(a.send);
    hub.handleClientMessage(idA, { type: "hello", role: "app", label: "App" });
    hub.handleClientMessage(idA, { type: "set", slot: "armed", value: true });

    // A second view joins → snapshot carries the cached armed slot + peer A.
    const b = fakeConn();
    const idB = hub.addConnection(b.send);
    hub.handleClientMessage(idB, { type: "hello", role: "code", label: "Reader" });

    const snap = b.received.find((m) => m.type === "snapshot");
    expect(snap).toBeDefined();
    if (snap?.type !== "snapshot") throw new Error("no snapshot");
    expect(snap.clientId).toBe(idB);
    expect(snap.state).toEqual({ armed: true });
    expect(snap.peers.map((p) => p.role).sort()).toEqual(["app", "code"]);
  });

  it("broadcasts a set to every OTHER view and caches it", () => {
    const hub = new SessionHub({ newId: seqIds(), log: () => {} });
    const a = fakeConn();
    const b = fakeConn();
    const idA = hub.addConnection(a.send);
    const idB = hub.addConnection(b.send);
    hub.handleClientMessage(idA, { type: "hello", role: "app" });
    hub.handleClientMessage(idB, { type: "hello", role: "code" });

    a.received.length = 0;
    b.received.length = 0;
    hub.handleClientMessage(idA, { type: "set", slot: "armed", value: true });

    // Sender does NOT get an echo; the other view does.
    expect(a.received.some((m) => m.type === "set")).toBe(false);
    const set = b.received.find((m) => m.type === "set");
    expect(set).toMatchObject({ type: "set", slot: "armed", value: true, from: idA });
    expect(hub.get("armed")).toBe(true);
  });

  it("relays a publish transiently (no cache) to other views", () => {
    const hub = new SessionHub({ newId: seqIds(), log: () => {} });
    const a = fakeConn();
    const b = fakeConn();
    const idA = hub.addConnection(a.send);
    const idB = hub.addConnection(b.send);
    hub.handleClientMessage(idA, { type: "hello", role: "app" });
    hub.handleClientMessage(idB, { type: "hello", role: "code" });
    b.received.length = 0;

    hub.handleClientMessage(idB, {
      type: "publish",
      topic: "contribution",
      payload: { kind: "selection", text: "Vec3" },
    });
    // Delivered to the app view; not cached as shared state.
    const pub = a.received.find((m) => m.type === "publish");
    expect(pub).toMatchObject({ type: "publish", topic: "contribution", from: idB });
    expect(hub.get("contribution")).toBeUndefined();
  });

  it("announces peer join and leave", () => {
    const hub = new SessionHub({ newId: seqIds(), log: () => {} });
    const a = fakeConn();
    const idA = hub.addConnection(a.send);
    hub.handleClientMessage(idA, { type: "hello", role: "app" });

    const b = fakeConn();
    const idB = hub.addConnection(b.send);
    a.received.length = 0;
    hub.handleClientMessage(idB, { type: "hello", role: "code" });
    // A learns B joined.
    const grew = a.received.find((m) => m.type === "peers");
    expect(grew?.type === "peers" && grew.peers.map((p) => p.role).sort()).toEqual(["app", "code"]);

    a.received.length = 0;
    hub.removeConnection(idB);
    const shrank = a.received.find((m) => m.type === "peers");
    expect(shrank?.type === "peers" && shrank.peers.map((p) => p.role)).toEqual(["app"]);
  });

  it("ignores malformed messages and a leave before hello is silent", () => {
    const hub = new SessionHub({ newId: seqIds(), log: () => {} });
    const a = fakeConn();
    const idA = hub.addConnection(a.send);
    hub.handleClientMessage(idA, { type: "hello", role: "app" });
    a.received.length = 0;

    hub.handleClientMessage(idA, null);
    hub.handleClientMessage(idA, { type: "set" }); // no slot
    hub.handleClientMessage(idA, { type: "publish" }); // no topic
    expect(a.received).toHaveLength(0);

    // A connection that never greeted leaves without a peers broadcast.
    const b = fakeConn();
    const idB = hub.addConnection(b.send);
    hub.removeConnection(idB);
    expect(a.received.some((m) => m.type === "peers")).toBe(false);
  });

  it("lists greeted peers and delivers a server-originated publish", () => {
    const hub = new SessionHub({ newId: seqIds(), log: () => {} });
    const app = fakeConn();
    const code = fakeConn();
    const mute = fakeConn(); // connected but never greeted → not addressable
    const idApp = hub.addConnection(app.send);
    const idCode = hub.addConnection(code.send);
    hub.addConnection(mute.send);
    hub.handleClientMessage(idApp, { type: "hello", role: "app", label: "Demo" });
    hub.handleClientMessage(idCode, { type: "hello", role: "code" });

    expect(
      hub
        .peers()
        .map((p) => p.role)
        .sort(),
    ).toEqual(["app", "code"]);

    // Target one view by clientId: only it receives, and the return names it.
    app.received.length = 0;
    code.received.length = 0;
    const payload = { kind: "selection", text: "Vec3" };
    const sent = hub.publishFromServer("contribution", payload, { clientId: idApp });
    expect(sent.map((p) => p.clientId)).toEqual([idApp]);
    expect(app.received).toEqual([
      { v: 1, type: "publish", topic: "contribution", payload, from: "server" },
    ]);
    expect(code.received).toHaveLength(0);

    // Target by role, and miss entirely: an unknown target sends to nobody.
    expect(hub.publishFromServer("nudge", undefined, { role: "code" })).toEqual([
      { clientId: idCode, role: "code" },
    ]);
    expect(hub.publishFromServer("nudge", undefined, { clientId: "nope" })).toEqual([]);
    expect(hub.publishFromServer("nudge", undefined, { role: "git" })).toEqual([]);

    // No target → every greeted view; the un-greeted connection (which does see
    // ordinary peer-list broadcasts) is not addressable and hears no publish.
    expect(
      hub
        .publishFromServer("nudge", undefined)
        .map((p) => p.clientId)
        .sort(),
    ).toEqual([idApp, idCode].sort());
    expect(mute.received.filter((m) => m.type === "publish")).toHaveLength(0);
  });

  it("summarizes clients, slots, and roles", () => {
    const hub = new SessionHub({ newId: seqIds(), log: () => {} });
    const a = fakeConn();
    const b = fakeConn();
    const idA = hub.addConnection(a.send);
    const idB = hub.addConnection(b.send);
    hub.handleClientMessage(idA, { type: "hello", role: "app" });
    hub.handleClientMessage(idB, { type: "hello", role: "code" });
    hub.handleClientMessage(idA, { type: "set", slot: "armed", value: false });
    hub.handleClientMessage(idA, { type: "set", slot: "preview", value: { text: "hi" } });

    expect(hub.summary()).toEqual({ clients: 2, slots: 2, roles: ["app", "code"] });
  });
});
