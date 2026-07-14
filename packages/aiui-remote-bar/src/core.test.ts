import { describe, expect, it, vi } from "vitest";
import { BarClient, BarHost } from "./core";
import type { ClientToRelay, HostToRelay, WireCap } from "./protocol";

const cap = (command: string, over: Partial<WireCap> = {}): WireCap => ({
  kind: "cap",
  command,
  hint: { key: command[0], label: command },
  lit: false,
  enabled: true,
  ...over,
});

describe("BarHost — projecting the engine", () => {
  it("publishes a bar frame with rows, claims, and phase", () => {
    const sent: HostToRelay[] = [];
    const host = new BarHost({ send: (m) => sent.push(m) });
    host.publishBar([cap("ink"), cap("send")], { ring: "active" }, "turn");
    expect(sent).toEqual([
      { type: "bar", rows: [cap("ink"), cap("send")], claims: { ring: "active" }, phase: "turn" },
    ]);
  });

  it("omits phase when it is undefined (a lean frame)", () => {
    const sent: HostToRelay[] = [];
    const host = new BarHost({ send: (m) => sent.push(m) });
    host.publishBar([cap("ink")], {});
    expect(sent[0]).toEqual({ type: "bar", rows: [cap("ink")], claims: {} });
    expect("phase" in (sent[0] as object)).toBe(false);
  });

  it("applies the app-level filter — a rejected cap never reaches the wire (D5 subset)", () => {
    const sent: HostToRelay[] = [];
    const host = new BarHost({
      send: (m) => sent.push(m),
      filter: (c) => c.command !== "danger",
    });
    host.publishBar([cap("ink"), cap("danger"), cap("send")], {});
    expect(sent[0]).toMatchObject({ rows: [cap("ink"), cap("send")] });
  });

  it("copies the rows it sends — the caller may keep mutating its own array", () => {
    const sent: HostToRelay[] = [];
    const host = new BarHost({ send: (m) => sent.push(m) });
    const rows = [cap("ink")];
    host.publishBar(rows, {});
    rows.push(cap("send"));
    expect((sent[0] as { rows: WireCap[] }).rows).toHaveLength(1);
  });

  it("routes an inbound command to onCommand (the only inbound verb)", () => {
    const onCommand = vi.fn();
    const host = new BarHost({ send: () => {}, onCommand });
    host.receive({ type: "command", command: "send", payload: { via: "tap" } });
    expect(onCommand).toHaveBeenCalledWith("send", { via: "tap" });
  });

  it("surfaces client join/leave lifecycle", () => {
    const onClientJoined = vi.fn();
    const onClientLeft = vi.fn();
    const host = new BarHost({ send: () => {}, onClientJoined, onClientLeft });
    host.receive({ type: "clientJoined", client: "c-1" });
    host.receive({ type: "clientLeft", client: "c-1" });
    expect(onClientJoined).toHaveBeenCalledWith("c-1");
    expect(onClientLeft).toHaveBeenCalledWith("c-1");
  });

  it("ignores a registered frame without throwing", () => {
    const host = new BarHost({ send: () => {} });
    expect(() => host.receive({ type: "registered", id: "host-1" })).not.toThrow();
  });
});

describe("BarClient — viewing and tapping", () => {
  it("sends join / leave", () => {
    const sent: ClientToRelay[] = [];
    const client = new BarClient({ send: (m) => sent.push(m) });
    client.join("host-1");
    client.leave();
    expect(sent).toEqual([{ type: "join", host: "host-1" }, { type: "leave" }]);
  });

  it("a tap is a command — the same verb a key would dispatch", () => {
    const sent: ClientToRelay[] = [];
    const client = new BarClient({ send: (m) => sent.push(m) });
    client.dispatch("ink", { on: true });
    client.dispatch("send");
    expect(sent).toEqual([
      { type: "command", command: "ink", payload: { on: true } },
      { type: "command", command: "send" },
    ]);
  });

  it("routes each relay frame to its callback", () => {
    const onSessions = vi.fn();
    const onJoined = vi.fn();
    const onJoinRejected = vi.fn();
    const onBar = vi.fn();
    const onHostGone = vi.fn();
    const client = new BarClient({
      send: () => {},
      onSessions,
      onJoined,
      onJoinRejected,
      onBar,
      onHostGone,
    });

    client.receive({ type: "sessions", sessions: [] });
    client.receive({ type: "joined", host: "host-1", label: "app" });
    client.receive({ type: "joinRejected", reason: "host not found" });
    client.receive({ type: "bar", rows: [cap("ink")], claims: { ring: "pending" }, phase: "turn" });
    client.receive({ type: "hostGone" });

    expect(onSessions).toHaveBeenCalledWith([]);
    expect(onJoined).toHaveBeenCalledWith("host-1", "app");
    expect(onJoinRejected).toHaveBeenCalledWith("host not found");
    expect(onBar).toHaveBeenCalledWith([cap("ink")], { ring: "pending" }, "turn");
    expect(onHostGone).toHaveBeenCalledTimes(1);
  });
});
