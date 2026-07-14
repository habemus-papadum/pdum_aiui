import type { CapView } from "@habemus-papadum/aiui-viz/modal";
import { describe, expect, it } from "vitest";
import {
  type BarState,
  decode,
  encode,
  isRemoteCommand,
  PROTOCOL_VERSION,
  type RemoteCommand,
  type SessionInfo,
  type WireCap,
} from "./protocol";

describe("framing", () => {
  it("round-trips a message", () => {
    const command: RemoteCommand = { type: "command", command: "ink", payload: { on: true } };
    expect(decode(encode(command))).toEqual(command);
  });

  it("drops a malformed frame instead of throwing — one bad client must not sink the relay", () => {
    expect(decode("not json")).toBeUndefined();
    expect(decode("[1,2,3]")).toBeUndefined(); // JSON, but not a message
    expect(decode('{"no":"type"}')).toBeUndefined();
    expect(decode("null")).toBeUndefined();
  });

  it("recognises a remote command — the relay's routing test, and the host's guard", () => {
    expect(isRemoteCommand({ type: "command", command: "send" })).toBe(true);
    expect(isRemoteCommand({ type: "command", command: "send", payload: 1 })).toBe(true);
    expect(isRemoteCommand({ type: "command" })).toBe(false); // no string command
    expect(isRemoteCommand({ type: "bar", rows: [], claims: {} })).toBe(false);
    expect(isRemoteCommand(undefined)).toBe(false);
  });

  it("carries a version constant", () => {
    expect(typeof PROTOCOL_VERSION).toBe("number");
  });
});

describe("the control plane is the bar model, verbatim", () => {
  it("accepts a real CapView as a WireCap — if the bar drops a field, this fails", () => {
    // The point of the assertion: `WireCap` is restated in protocol.ts so the
    // relay does not drag the whole modal kit in. That is only safe if the two
    // cannot drift, so the compiler is made to check it here — a `CapView`
    // (which carries MORE than a WireCap) must remain assignable to a WireCap.
    const cap: CapView = {
      kind: "cap",
      command: "ink",
      payload: { on: true },
      hold: { down: "ptt.down", up: "ptt.up" },
      hint: { key: "i", label: "ink", tone: "accent" },
      lit: true,
      enabled: true,
    };
    const wire: WireCap = cap;
    const bar: BarState = { type: "bar", rows: [wire], claims: { ring: "active" }, phase: "turn" };
    expect(decode(encode(bar))).toEqual({
      type: "bar",
      rows: [
        {
          kind: "cap",
          command: "ink",
          payload: { on: true },
          hold: { down: "ptt.down", up: "ptt.up" },
          hint: cap.hint,
          lit: true,
          enabled: true,
        },
      ],
      claims: { ring: "active" },
      phase: "turn",
    });
  });

  it("a bar with an empty row set and no phase still round-trips", () => {
    const bar: BarState = { type: "bar", rows: [], claims: {} };
    expect(decode(encode(bar))).toEqual(bar);
  });
});

describe("session plumbing", () => {
  it("round-trips a sessions listing", () => {
    const sessions: SessionInfo[] = [
      {
        id: "host-1",
        label: "my app",
        project: "/proj",
        channelTag: "tag-1",
        busy: false,
        connectedAt: "2026-07-14T00:00:00.000Z",
      },
    ];
    expect(decode(encode({ type: "sessions", sessions }))).toEqual({ type: "sessions", sessions });
  });
});
