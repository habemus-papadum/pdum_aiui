import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { mountAiuiCodeBackend } from "./backend";

// An empty project: no manifest, no language servers — mounting is cheap and
// nothing spawns (servers spawn lazily per websocket attach).
const root = mkdtempSync(join(tmpdir(), "aiui-backend-test-"));
const backend = mountAiuiCodeBackend({ root, onLog: () => {} });
afterAll(() => {
  backend.dispose();
  rmSync(root, { recursive: true, force: true });
});

describe("mountAiuiCodeBackend request-target hygiene", () => {
  // `//[` is accepted by Node's HTTP parser but not by WHATWG `new URL` — the
  // handlers must decline it, never throw: handleHttp runs on EVERY host request
  // and a rejection would surface as an unhandled rejection in the host process
  // (this crashed the live channel before the parse was hardened).
  it("handleHttp declines a malformed request-target instead of rejecting", async () => {
    const req = { url: "//[", method: "GET" } as never;
    const res = {} as never; // must not be touched for a declined request
    await expect(Promise.resolve(backend.handleHttp(req, res))).resolves.toBe(false);
  });

  it("handleUpgrade declines a malformed request-target instead of throwing", () => {
    const req = { url: "//[" } as never;
    const socket = { destroy: () => {} } as never;
    expect(backend.handleUpgrade(req, socket, Buffer.alloc(0))).toBe(false);
  });

  it("still routes a well-formed foreign path to the host", async () => {
    const req = { url: "/not-ours", method: "GET" } as never;
    await expect(Promise.resolve(backend.handleHttp(req, {} as never))).resolves.toBe(false);
  });
});
