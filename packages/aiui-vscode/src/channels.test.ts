import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  PeersResponse as ChannelPeersResponse,
  PublishResult as ChannelPublishResult,
  SessionPeerInfo,
} from "@habemus-papadum/aiui-claude-channel";
import { afterEach, describe, expect, it } from "vitest";
import {
  channelLabel,
  fetchPeers,
  listChannels,
  type PeersResponse,
  type PublishResult,
  publishSelection,
  type SessionPeer,
} from "./channels";
import { selectionToContribution } from "./contribution";

describe("session HTTP response shapes stay in lockstep with the channel", () => {
  // The channel serves /session/peers and /session/publish; this package mirrors
  // those response shapes so the VSIX bundle needn't drag in the channel. The
  // cross-typed assignments below are the drift guard — type-only, erased before
  // esbuild, so they add nothing to the bundle. The one deliberate asymmetry is a
  // peer's `tab`: typed `TabInfo` on the channel, opaque `Record<string, unknown>`
  // here — so `tab` is excluded from the peer-record checks and the response
  // envelopes are compared past their peer lists.
  it("peer records agree on every field but `tab`, both directions", () => {
    const channelPeer: SessionPeerInfo = { clientId: "c1", role: "vscode", label: "L", url: "u" };
    const asVscode: Omit<SessionPeer, "tab"> = channelPeer;
    const vscodePeer: SessionPeer = { clientId: "c2", role: "app", tab: { any: 1 } };
    const asChannel: Omit<SessionPeerInfo, "tab"> = vscodePeer;
    expect(asVscode.clientId).toBe("c1");
    expect(asChannel.clientId).toBe("c2");
  });

  it("response envelopes agree, both directions (past their peer lists)", () => {
    const channelPeers: ChannelPeersResponse = { ok: true, peers: [], armed: true };
    const vscodePeersEnv: Omit<PeersResponse, "peers"> = channelPeers;
    const vscodePeers: PeersResponse = { ok: true, peers: [], armed: false };
    const channelPeersEnv: Omit<ChannelPeersResponse, "peers"> = vscodePeers;

    const channelPub: ChannelPublishResult = { ok: false, error: "x" };
    const vscodePubEnv: Omit<PublishResult, "delivered"> = channelPub;
    const vscodePub: PublishResult = { ok: true, armed: true };
    const channelPubEnv: Omit<ChannelPublishResult, "delivered"> = vscodePub;

    expect(vscodePeersEnv.armed).toBe(true);
    expect(channelPeersEnv.armed).toBe(false);
    expect(vscodePubEnv.error).toBe("x");
    expect(channelPubEnv.ok).toBe(true);
  });
});

function entry(overrides: Partial<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    tag: "alpha",
    pid: 1234,
    ppid: 1,
    port: 4321,
    cwd: "/w/app",
    startedAt: "2026-07-07T10:00:00.000Z",
    ...overrides,
  });
}

describe("listChannels", () => {
  it("returns live, well-formed entries and skips the rest (never pruning)", () => {
    const dir = mkdtempSync(join(tmpdir(), "aiui-vscode-registry-"));
    writeFileSync(join(dir, "1.json"), entry({ pid: 1, tag: "live" }));
    writeFileSync(join(dir, "2.json"), entry({ pid: 2, tag: "dead" }));
    writeFileSync(join(dir, "3.json"), "not json");
    writeFileSync(join(dir, "4.json"), JSON.stringify({ tag: "incomplete" }));

    const channels = listChannels({ dir, isAlive: (pid) => pid === 1 });
    expect(channels.map((c) => c.tag)).toEqual(["live"]);
  });

  it("sorts workspace-affine channels first, then newest", () => {
    const dir = mkdtempSync(join(tmpdir(), "aiui-vscode-registry-"));
    writeFileSync(
      join(dir, "1.json"),
      entry({ pid: 1, tag: "elsewhere", cwd: "/elsewhere", startedAt: "2026-07-07T12:00:00Z" }),
    );
    writeFileSync(
      join(dir, "2.json"),
      entry({ pid: 2, tag: "ancestor", cwd: "/w", startedAt: "2026-07-07T12:00:00Z" }),
    );
    writeFileSync(
      join(dir, "3.json"),
      entry({ pid: 3, tag: "exact", cwd: "/w/app", startedAt: "2026-07-07T09:00:00Z" }),
    );
    writeFileSync(
      join(dir, "4.json"),
      entry({ pid: 4, tag: "exact-newer", cwd: "/w/app", startedAt: "2026-07-07T11:00:00Z" }),
    );

    const channels = listChannels({ dir, isAlive: () => true, workspaceDir: "/w/app" });
    expect(channels.map((c) => c.tag)).toEqual(["exact-newer", "exact", "ancestor", "elsewhere"]);
  });

  it("carries the debug marker + name through, sorting debug after real sessions", () => {
    const dir = mkdtempSync(join(tmpdir(), "aiui-vscode-registry-"));
    writeFileSync(
      join(dir, "1.json"),
      entry({
        pid: 1,
        tag: "wb",
        name: "aiui debug",
        debug: true,
        startedAt: "2026-07-07T12:00:00Z",
      }),
    );
    writeFileSync(
      join(dir, "2.json"),
      entry({ pid: 2, tag: "real", startedAt: "2026-07-07T09:00:00Z" }),
    );

    const channels = listChannels({ dir, isAlive: () => true, workspaceDir: "/w/app" });
    // Same affinity; the older REAL session still outranks the newer debug one.
    expect(channels.map((c) => c.tag)).toEqual(["real", "wb"]);
    expect(channels[1]).toMatchObject({ name: "aiui debug", debug: true });
  });

  it("treats a missing registry directory as nothing running", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "aiui-vscode-registry-")), "absent");
    expect(listChannels({ dir })).toEqual([]);
    // And reading never creates it.
    expect(() => mkdirSync(dir)).not.toThrow();
  });
});

describe("channelLabel", () => {
  it("prefers the display name and marks debug", () => {
    const base = {
      pid: 1,
      ppid: 1,
      port: 1,
      cwd: "/w",
      startedAt: "2026-07-07T00:00:00Z",
    };
    expect(channelLabel({ ...base, tag: "abc-123" })).toBe("abc-123");
    expect(channelLabel({ ...base, tag: "wb", name: "aiui debug", debug: true })).toBe(
      "aiui debug · debug",
    );
  });
});

describe("session HTTP client", () => {
  let server: Server | undefined;

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      server ? server.close(() => resolve()) : resolve();
    });
    server = undefined;
  });

  /** A canned channel web backend: records the publish request it receives. */
  async function listen(
    handler: (url: string, body: string) => { status: number; body: unknown },
  ): Promise<{ port: number; requests: Array<{ url: string; body: string }> }> {
    const requests: Array<{ url: string; body: string }> = [];
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        requests.push({ url: req.url ?? "", body });
        const out = handler(req.url ?? "", body);
        res.writeHead(out.status, { "content-type": "application/json" });
        res.end(JSON.stringify(out.body));
      });
    });
    const s = server;
    await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
    const address = s.address();
    if (typeof address !== "object" || address === null) {
      throw new Error("no address");
    }
    return { port: address.port, requests };
  }

  it("fetchPeers parses the peer list", async () => {
    const peers = [{ clientId: "c1", role: "intent-client", label: "Demo" }];
    const { port } = await listen(() => ({ status: 200, body: { ok: true, peers, armed: true } }));
    expect(await fetchPeers(port)).toEqual({ ok: true, peers, armed: true });
  });

  it("publishSelection posts the contribution on the contribution topic", async () => {
    const delivered = [{ clientId: "c1", role: "intent-client" }];
    const { port, requests } = await listen(() => ({
      status: 200,
      body: { ok: true, delivered, armed: false },
    }));
    const contribution = selectionToContribution({
      file: "src/a.ts",
      text: "x",
      startLine: 0,
      startCharacter: 0,
      endLine: 0,
      endCharacter: 1,
    });
    const result = await publishSelection(port, "c1", contribution);
    expect(result).toEqual({ ok: true, delivered, armed: false });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("/session/publish");
    expect(JSON.parse(requests[0]?.body ?? "")).toEqual({
      clientId: "c1",
      topic: "contribution",
      payload: contribution,
    });
  });

  it("returns the server's nack body instead of throwing", async () => {
    const { port } = await listen(() => ({
      status: 404,
      body: { ok: false, error: 'no connected session view matches view "c9"' },
    }));
    const result = await publishSelection(port, "c9", {
      kind: "selection",
      text: "x",
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("c9");
  });

  it("throws when the channel itself is unreachable", async () => {
    const { port } = await listen(() => ({ status: 200, body: { ok: true } }));
    const s = server;
    await new Promise<void>((resolve) => s?.close(() => resolve()));
    server = undefined;
    await expect(fetchPeers(port, 500)).rejects.toThrow();
  });
});
