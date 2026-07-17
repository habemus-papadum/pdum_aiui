/**
 * remote.test.ts — the endpoint cores and the fade window (plan decision D3).
 *
 * Under D3 there is no retirement contract to test — the preview fades on a
 * clock the app owns. What still has to be right, and is pinned here: the wire
 * carries the whole instrument; the host renders remote intent through the same
 * path a local pen takes, at the host's own scale, with the host's own brush;
 * signaling passes through both endpoints opaquely; and the fade window's
 * arithmetic errs long, never short.
 */
import { describe, expect, it, vi } from "vitest";
import { WRITE } from "./pencil";
import type { ClientToRelay } from "./protocol";
import { fadeWindowMs, PREVIEW_FADE_MS, RemoteClient, RemoteHost } from "./remote";
import type { PencilSurface } from "./surface";
import type { PenSample } from "./telemetry";

const sample = (over: Partial<PenSample> = {}): PenSample => ({
  x: 50,
  y: 50,
  t: 0,
  pressure: 0.5,
  altitude: Math.PI / 2,
  azimuth: 0,
  twist: 0,
  kind: "pen",
  width: 0,
  height: 0,
  ...over,
});

describe("fadeWindowMs — D3's 'a little more scientific'", () => {
  it("is exactly paint v1's constant when nothing was measured", () => {
    expect(fadeWindowMs()).toBe(PREVIEW_FADE_MS);
    expect(fadeWindowMs({})).toBe(PREVIEW_FADE_MS);
  });

  it("sizes down on a LAN, but never below the flicker floor", () => {
    // A good LAN: 5 ms RTT, tiny jitter buffer, 60 fps. The estimate is small,
    // but a 150 ms fade would read as flicker — the floor holds it at 300.
    const lan = fadeWindowMs({ rttMs: 5, jitterBufferMs: 20, frameIntervalMs: 16.7 });
    expect(lan).toBeGreaterThanOrEqual(300);
    expect(lan).toBeLessThan(PREVIEW_FADE_MS);
  });

  it("sizes up on a bad link, but never past the broken ceiling", () => {
    const awful = fadeWindowMs({ rttMs: 800, jitterBufferMs: 500, frameIntervalMs: 100 });
    expect(awful).toBe(1500);
  });

  it("grows with RTT — the failure modes are not symmetric, so it errs long", () => {
    const near = fadeWindowMs({ rttMs: 30, jitterBufferMs: 60, frameIntervalMs: 33 });
    const far = fadeWindowMs({ rttMs: 200, jitterBufferMs: 60, frameIntervalMs: 33 });
    expect(far).toBeGreaterThan(near);
    // …and the window comfortably exceeds the raw estimate itself: a preview
    // that outlives the truth darkens a stroke briefly; one that dies first
    // leaves a hole in the ink.
    expect(far).toBeGreaterThan(200 + 60 + 2 * 33 + 80);
  });
});

describe("RemoteClient — intent out, projections in", () => {
  const setup = () => {
    const sent: ClientToRelay[] = [];
    const client = new RemoteClient({
      send: (m) => sent.push(m),
      surface: () => ({ width: 100, height: 100 }),
      tool: () => "draw",
      mode: () => "write",
    });
    return { client, sent };
  };

  it("sends intent — the tool and the mode ride on the begin", () => {
    const { client, sent } = setup();
    client.begin("s1", sample({ x: 25, y: 75 }));
    client.points("s1", [sample({ x: 50, y: 50 })]);
    client.end("s1");

    expect(sent.map((m) => m.type)).toEqual(["strokeBegin", "strokePoints", "strokeEnd"]);
    const begin = sent[0] as Extract<ClientToRelay, { type: "strokeBegin" }>;
    expect(begin.tool).toBe("draw");
    expect(begin.mode).toBe("write");
    expect(begin.point.u).toBeCloseTo(0.25); // normalized against ITS canvas
    expect(begin.point.v).toBeCloseTo(0.75);
  });

  it("sends navigation gestures as plane-relative intents", () => {
    const { client, sent } = setup();
    client.scroll(0, 0.25);
    client.zoom(0.5, 0.5, 1.2);
    expect(sent).toEqual([
      { type: "scroll", du: 0, dv: 0.25 },
      { type: "zoom", centerU: 0.5, centerV: 0.5, scale: 1.2 },
    ]);
  });

  it("ferries signaling both ways, opaquely", () => {
    const { sent } = setup();
    const gotSignal = vi.fn();
    const client = new RemoteClient({
      send: (m) => sent.push(m),
      surface: () => ({ width: 10, height: 10 }),
      tool: () => "draw",
      mode: () => "write",
      onSignal: gotSignal,
    });

    client.receive({ type: "signal", data: { sdp: "offer…" } });
    expect(gotSignal).toHaveBeenCalledWith({ sdp: "offer…" });

    client.signal({ sdp: "answer…" });
    expect(sent.at(-1)).toEqual({ type: "signal", data: { sdp: "answer…" } });
  });
});

describe("RemoteHost — wire intent becomes the same pencil", () => {
  /** A PencilSurface that records what it was asked to draw. */
  const stubSurface = () => {
    const calls: Array<{ op: string; id?: string; x?: number; y?: number; params?: unknown }> = [];
    const surface = {
      remoteBegin: (id: string, opts: { tool: string; params: unknown; point: PenSample }) =>
        calls.push({
          op: `begin:${opts.tool}`,
          id,
          x: opts.point.x,
          y: opts.point.y,
          params: opts.params,
        }),
      remotePoint: (id: string, p: PenSample) => calls.push({ op: "point", id, x: p.x, y: p.y }),
      remoteEnd: (id: string) => calls.push({ op: "end", id }),
      remoteCancel: (id: string) => calls.push({ op: "cancel", id }),
      undo: () => calls.push({ op: "undo" }),
      clear: () => calls.push({ op: "clear" }),
    };
    return { calls, surface: surface as unknown as PencilSurface };
  };

  it("maps normalized points onto the HOST's canvas, and renders progressively", () => {
    const { calls, surface } = stubSurface();
    const host = new RemoteHost({
      send: () => {},
      surface: () => surface,
      size: () => ({ width: 200, height: 100 }), // not the iPad's size — the point
    });

    host.receive({
      type: "strokeBegin",
      id: "s1",
      pointerType: "pen",
      tool: "draw",
      mode: "write",
      point: { u: 0.5, v: 0.5, t: 0 },
    });
    host.receive({ type: "strokePoints", id: "s1", points: [{ u: 0.75, v: 0.25, t: 8 }] });

    // The stroke is live on the surface BEFORE strokeEnd arrives — a viewer
    // watching the host sees ink appear as it is drawn (D3).
    expect(calls.map((c) => c.op)).toEqual(["begin:draw", "point"]);
    expect(calls[0]).toMatchObject({ x: 100, y: 50 });
    expect(calls[1]).toMatchObject({ x: 150, y: 25 });

    host.receive({ type: "strokeEnd", id: "s1" });
    expect(calls.at(-1)?.op).toBe("end");
  });

  it("merges the client's brush overrides over the host-resolved preset (host stays authoritative)", () => {
    const { calls, surface } = stubSurface();
    const host = new RemoteHost({
      send: () => {},
      surface: () => surface,
      size: () => ({ width: 100, height: 100 }),
    });
    host.receive({
      type: "strokeBegin",
      id: "s1",
      pointerType: "pen",
      tool: "draw",
      mode: "write",
      overrides: { color: "#ff0000", size: 9 },
      point: { u: 0, v: 0, t: 0 },
    });
    // Preset fields survive; only the offered knobs move.
    const params = calls[0].params as { color: string; size: number; spacing: number };
    expect(params.color).toBe("#ff0000");
    expect(params.size).toBe(9);
    expect(params.spacing).toBeGreaterThan(0); // the rest of the preset intact
  });

  it("resolves the brush on the host — the wire carries a mode, never parameters", () => {
    const { calls, surface } = stubSurface();
    const myBrush = { ...WRITE, size: 9 };
    const host = new RemoteHost({
      send: () => {},
      surface: () => surface,
      size: () => ({ width: 100, height: 100 }),
      params: (mode) => (mode === "write" ? myBrush : WRITE),
    });

    host.receive({
      type: "strokeBegin",
      id: "s1",
      pointerType: "pen",
      tool: "erase",
      mode: "write",
      point: { u: 0, v: 0, t: 0 },
    });

    expect(calls[0].op).toBe("begin:erase"); // the stroke keeps its tool…
    expect(calls[0].params).toBe(myBrush); // …and gets the HOST's live brush
  });

  it("routes undo/clear to the surface, scroll/zoom to the app's handlers", () => {
    const { calls, surface } = stubSurface();
    const onScroll = vi.fn();
    const onZoom = vi.fn();
    const host = new RemoteHost({
      send: () => {},
      surface: () => surface,
      size: () => ({ width: 100, height: 100 }),
      onScroll,
      onZoom,
    });

    host.receive({ type: "undo" });
    host.receive({ type: "clear" });
    expect(calls.map((c) => c.op)).toEqual(["undo", "clear"]);

    // Navigation never touches the surface: what "scroll" MEANS belongs to the
    // app (window scroll for an overlay; maybe nothing for a scratchpad).
    host.receive({ type: "scroll", du: 0, dv: 0.25 });
    host.receive({ type: "zoom", centerU: 0.5, centerV: 0.5, scale: 1.2 });
    expect(onScroll).toHaveBeenCalledWith(0, 0.25);
    expect(onZoom).toHaveBeenCalledWith(0.5, 0.5, 1.2);
    expect(calls.map((c) => c.op)).toEqual(["undo", "clear"]);
  });

  it("addresses signaling to one viewer — WebRTC is point-to-point", () => {
    const sent: Array<Record<string, unknown>> = [];
    const { surface } = stubSurface();
    const onSignal = vi.fn();
    const host = new RemoteHost({
      send: (m) => sent.push(m),
      surface: () => surface,
      size: () => ({ width: 100, height: 100 }),
      onSignal,
    });

    host.receive({ type: "signal", peer: "client-7", data: { sdp: "answer…" } });
    expect(onSignal).toHaveBeenCalledWith("client-7", { sdp: "answer…" });

    host.signal("client-7", { candidate: "…" });
    expect(sent.at(-1)).toEqual({ type: "signal", peer: "client-7", data: { candidate: "…" } });
  });
});
