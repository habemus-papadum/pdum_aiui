import { describe, expect, it } from "vitest";
import { availableBackends, probeServer } from "./backends";

describe("availableBackends", () => {
  it("gates the browser backends on a key and the server ones on the live routes", () => {
    const none = availableBackends({ key: false, server: false });
    expect(none.map((a) => [a.backend.id, a.enabled])).toEqual([
      ["responses-browser", false],
      ["hosted", false],
      ["responses-server", false],
      ["claude", false],
    ]);
    expect(none[0]?.why).toMatch(/key/);
    expect(none[3]?.why).toMatch(/dev server/);
    const keyOnly = availableBackends({ key: true, server: false });
    expect(keyOnly.filter((a) => a.enabled).map((a) => a.backend.id)).toEqual([
      "responses-browser",
      "hosted",
    ]);
    // A server brokers the session, so hosted mode works without a browser key.
    const serverOnly = availableBackends({ key: false, server: true });
    expect(serverOnly.filter((a) => a.enabled).map((a) => a.backend.id)).toEqual([
      "hosted",
      "responses-server",
      "claude",
    ]);
  });
});

describe("probeServer", () => {
  const answering = (status: number): typeof fetch =>
    (async () => ({ status }) as Response) as typeof fetch;
  it("is true only for the live backend's 405, never for a fallback page or a 404", async () => {
    expect(await probeServer("/live/sessions", answering(405))).toBe(true);
    expect(await probeServer("/live/sessions", answering(404))).toBe(false);
    expect(await probeServer("/live/sessions", answering(200))).toBe(false);
    const failing = (async () => {
      throw new Error("offline");
    }) as typeof fetch;
    expect(await probeServer("/live/sessions", failing)).toBe(false);
  });
});
