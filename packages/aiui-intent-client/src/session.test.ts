import type {
  SessionClientMessage,
  SessionPeerInfo,
  SessionServerMessage,
} from "@habemus-papadum/aiui-claude-channel";
import {
  selectionToContribution,
  SESSION_CONTRIBUTION_TOPIC as VSCODE_CONTRIBUTION_TOPIC,
} from "@habemus-papadum/aiui-vscode";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  asBusPublish,
  asContributedSelection,
  type BusPeer,
  INITIAL_BUS_STATE,
  reduceBusMessage,
  resolveChannelPort,
  SESSION_CONTRIBUTION_TOPIC,
} from "./session";

/** Stub `location` with just the fields resolveChannelPort reads. */
const stubLocation = (fields: { search?: string; port?: string }): void => {
  vi.stubGlobal("location", { search: fields.search ?? "", port: fields.port ?? "" });
};

describe("resolveChannelPort", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("prefers an explicit argument over everything", () => {
    stubLocation({ search: "?channel=5555", port: "3000" });
    vi.stubEnv("VITE_AIUI_PORT", "49317");
    expect(resolveChannelPort(1234)).toBe(1234);
  });

  it("takes ?channel= over the injected env and the origin", () => {
    stubLocation({ search: "?channel=5555", port: "3000" });
    vi.stubEnv("VITE_AIUI_PORT", "49317");
    expect(resolveChannelPort()).toBe(5555);
  });

  it("takes VITE_AIUI_PORT over same-origin location.port (the dev-launcher path)", () => {
    // location.port is Vite's here; without the env win the page would probe
    // Vite, fail, and drop to the fake tier. The env is what fixes that.
    stubLocation({ search: "", port: "3000" });
    vi.stubEnv("VITE_AIUI_PORT", "49317");
    expect(resolveChannelPort()).toBe(49317);
  });

  it("falls back to same-origin location.port when the channel served the page", () => {
    stubLocation({ search: "", port: "49317" });
    expect(resolveChannelPort()).toBe(49317);
  });

  it("returns undefined with no origin port and nothing injected", () => {
    stubLocation({ search: "", port: "" });
    expect(resolveChannelPort()).toBeUndefined();
  });

  it("ignores a non-numeric ?channel / env value", () => {
    stubLocation({ search: "?channel=abc", port: "" });
    vi.stubEnv("VITE_AIUI_PORT", "not-a-port");
    expect(resolveChannelPort()).toBeUndefined();
  });
});

describe("asBusPublish", () => {
  it("narrows a publish frame, keeping payload and from", () => {
    expect(
      asBusPublish({
        v: 1,
        type: "publish",
        topic: "contribution",
        payload: { x: 1 },
        from: "server",
      }),
    ).toEqual({ topic: "contribution", payload: { x: 1 }, from: "server" });
  });

  it("rejects non-publish frames and malformed shapes", () => {
    expect(asBusPublish({ type: "snapshot", peers: [] })).toBeUndefined();
    expect(asBusPublish({ type: "publish" })).toBeUndefined(); // no topic
    expect(asBusPublish("publish")).toBeUndefined();
    expect(asBusPublish(null)).toBeUndefined();
  });
});

describe("asContributedSelection (the VS Code send-selection wire)", () => {
  it("accepts the extension's SelectionContribution shape", () => {
    // The exact payload aiui-vscode's selectionToContribution builds.
    const sel = asContributedSelection({
      topic: "contribution",
      payload: {
        kind: "selection",
        text: "const x = 1;",
        sourceLoc: "src/a.ts:5:1",
        url: "vscode://file/repo/src/a.ts:5:1",
        role: "vscode",
        lines: 1,
      },
    });
    expect(sel).toEqual({
      text: "const x = 1;",
      sourceLoc: "src/a.ts:5:1",
      url: "vscode://file/repo/src/a.ts:5:1",
      lines: 1,
    });
  });

  it("keeps only well-typed enrichment fields", () => {
    const sel = asContributedSelection({
      topic: "contribution",
      payload: { kind: "selection", text: "x", sourceLoc: 7, lines: "3" },
    });
    expect(sel).toEqual({ text: "x" });
  });

  it("yields undefined for other topics, other kinds, and empty selections", () => {
    expect(
      asContributedSelection({ topic: "other", payload: { kind: "selection", text: "x" } }),
    ).toBeUndefined();
    expect(
      asContributedSelection({ topic: "contribution", payload: { kind: "note", text: "x" } }),
    ).toBeUndefined();
    expect(
      asContributedSelection({ topic: "contribution", payload: { kind: "selection", text: "" } }),
    ).toBeUndefined();
    expect(asContributedSelection({ topic: "contribution" })).toBeUndefined();
  });
});

describe("session-bus contribution contract (vscode ⇄ intent-client)", () => {
  // The client restates the extension's contribution topic + payload shape so it
  // takes no dependency on the extension package. This round-trip runs vscode's
  // real builder through the client's real reader, so the two cannot drift.
  it("round-trips a vscode selection contribution through the client reader", () => {
    const editorSel = {
      file: "src/a.ts",
      text: "const x = 1;",
      startLine: 4,
      startCharacter: 0,
      endLine: 4,
      endCharacter: 12,
    };
    const url = "vscode://file/repo/src/a.ts:5:1";
    const sel = asContributedSelection({
      topic: VSCODE_CONTRIBUTION_TOPIC,
      payload: selectionToContribution(editorSel, url),
    });
    expect(sel).toEqual({ text: "const x = 1;", sourceLoc: "src/a.ts:5:1", url, lines: 1 });
  });

  it("agrees with vscode on the contribution topic", () => {
    expect(SESSION_CONTRIBUTION_TOPIC).toBe(VSCODE_CONTRIBUTION_TOPIC);
  });
});

describe("session-bus frame shapes stay in lockstep with the hub", () => {
  // BusPeer/reduceBusMessage/asBusPublish mirror the channel's session hub across
  // a forced cycle break (the channel depends on this client, so this can only
  // devDep the channel). Typing the hub's frames against the channel's own
  // SessionServerMessage/SessionClientMessage — erased at runtime — makes a hub
  // frame change fail the client's typecheck.
  it("a hub peer is a BusPeer", () => {
    const hubPeer: SessionPeerInfo = { clientId: "c1", role: "intent-client", label: "Demo" };
    const busPeer: BusPeer = hubPeer;
    expect(busPeer.clientId).toBe("c1");
  });

  it("reduces the hub's snapshot/set/peers frames", () => {
    const peers: SessionPeerInfo[] = [{ clientId: "c1", role: "intent-client", label: "Demo" }];
    const snapshot: SessionServerMessage = {
      v: 1,
      type: "snapshot",
      clientId: "me",
      state: { armed: true },
      peers,
    };
    let state = reduceBusMessage(INITIAL_BUS_STATE, snapshot);
    expect(state.phase).toBe("connected");
    expect(state.clientId).toBe("me");
    expect(state.peers).toEqual(peers);
    expect(state.slots).toEqual({ armed: true });

    const set: SessionServerMessage = {
      v: 1,
      type: "set",
      slot: "preview",
      value: "hi",
      from: "c1",
    };
    state = reduceBusMessage(state, set);
    expect(state.slots.preview).toBe("hi");

    const peersFrame: SessionServerMessage = { v: 1, type: "peers", peers: [] };
    state = reduceBusMessage(state, peersFrame);
    expect(state.peers).toEqual([]);
  });

  it("narrows the hub's publish frame", () => {
    const publish: SessionServerMessage = {
      v: 1,
      type: "publish",
      topic: "contribution",
      payload: { kind: "selection", text: "x" },
      from: "server",
    };
    expect(asBusPublish(publish)).toEqual({
      topic: "contribution",
      payload: { kind: "selection", text: "x" },
      from: "server",
    });
  });

  it("the client's hello/set/publish sends satisfy the hub's client-message type", () => {
    const hello: SessionClientMessage = {
      v: 1,
      type: "hello",
      role: "intent-client",
      label: "Demo",
    };
    const set: SessionClientMessage = { v: 1, type: "set", slot: "armed", value: true };
    const publish: SessionClientMessage = {
      v: 1,
      type: "publish",
      topic: "contribution",
      payload: { kind: "selection", text: "x" },
    };
    expect([hello.type, set.type, publish.type]).toEqual(["hello", "set", "publish"]);
  });
});
