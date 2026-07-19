/**
 * superviseMicGrant over faked permission/media seams: one test per browser
 * situation the startup probe must tell apart (see mic-grant.ts). The rows are
 * the pathways the console logging narrates — a persisted grant skips the
 * probe, the flagged session browser passes it silently, a stock side panel
 * fails it and gets the grant page, a sticky denial is never re-probed, and
 * the grant landing in the mic.html tab flips the open panel live.
 */

import { describe, expect, it, vi } from "vitest";
import { type MicGrantEnv, superviseMicGrant } from "./mic-grant";

interface FakeStatus {
  state: "granted" | "denied" | "prompt";
  onchange: (() => void) | null;
}

function harness(options: {
  state?: FakeStatus["state"];
  /** The probe's fate: a stream (granted), or a rejection (blocked). */
  probe?: "stream" | "rejects";
}) {
  const status: FakeStatus =
    options.state !== undefined
      ? { state: options.state, onchange: null }
      : { state: "prompt", onchange: null };
  const stopped: string[] = [];
  const getUserMedia = vi.fn(() =>
    options.probe === "stream"
      ? Promise.resolve({
          getTracks: () => [{ stop: () => stopped.push("audio") }],
        } as unknown as MediaStream)
      : Promise.reject(Object.assign(new Error("no prompt surface"), { name: "NotAllowedError" })),
  );
  const openGrantPage = vi.fn();
  const env: MicGrantEnv = {
    media: { getUserMedia } as unknown as MicGrantEnv["media"],
    permissions:
      options.state !== undefined
        ? ({ query: () => Promise.resolve(status as unknown as PermissionStatus) } as Permissions)
        : undefined,
    openGrantPage,
  };
  const granted: boolean[] = [];
  const blocked: string[] = [];
  const run = () =>
    superviseMicGrant(
      { setGranted: (g) => granted.push(g), onBlocked: (m) => blocked.push(m) },
      env,
    );
  return { run, status, granted, blocked, stopped, getUserMedia, openGrantPage };
}

describe("superviseMicGrant", () => {
  it("a persisted grant (stock Chrome after the dance) skips the probe entirely", async () => {
    const h = harness({ state: "granted" });
    await h.run();
    expect(h.granted).toEqual([true]);
    expect(h.getUserMedia).not.toHaveBeenCalled(); // no mic-indicator blip
    expect(h.openGrantPage).not.toHaveBeenCalled();
    expect(h.blocked).toEqual([]);
  });

  it('state "prompt" + probe success (the flagged session browser) is silent — no page, no message', async () => {
    const h = harness({ state: "prompt", probe: "stream" });
    await h.run();
    expect(h.granted).toEqual([true]);
    expect(h.stopped).toEqual(["audio"]); // the probe releases the device
    expect(h.openGrantPage).not.toHaveBeenCalled();
    expect(h.blocked).toEqual([]);
  });

  it('state "prompt" + probe rejection (a stock side panel) opens the grant page and says so', async () => {
    const h = harness({ state: "prompt", probe: "rejects" });
    await h.run();
    expect(h.granted).toEqual([false]);
    expect(h.openGrantPage).toHaveBeenCalledTimes(1);
    expect(h.blocked[0]).toContain("one-time grant");
  });

  it('state "denied" (a refused prompt, sticky) opens the grant page WITHOUT probing', async () => {
    const h = harness({ state: "denied" });
    await h.run();
    expect(h.granted).toEqual([false]);
    expect(h.getUserMedia).not.toHaveBeenCalled(); // denied never resolves — pointless
    expect(h.openGrantPage).toHaveBeenCalledTimes(1);
  });

  it("no permissions.query at all still settles the question through the probe", async () => {
    const h = harness({ probe: "rejects" });
    await h.run();
    expect(h.granted).toEqual([false]);
    expect(h.openGrantPage).toHaveBeenCalledTimes(1);
  });

  it("the grant landing in the mic.html tab flips the panel live (onchange)", async () => {
    const h = harness({ state: "prompt", probe: "rejects" });
    await h.run();
    expect(h.granted).toEqual([false]);
    h.status.state = "granted";
    h.status.onchange?.(); // what the browser fires when the other tab grants
    expect(h.granted).toEqual([false, true]);
  });
});
