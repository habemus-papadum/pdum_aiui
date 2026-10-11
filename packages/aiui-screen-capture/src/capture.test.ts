import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createScreenCapture } from "./capture";
import { frameRate } from "./model";
import type { ScreenCapture, ScreenCaptureDriver } from "./types";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
class Track extends EventTarget {
  kind = "video";
  label = "Test tab";
  enabled = true;
  muted = false;
  readyState = "live";
  settings = { width: 800, height: 600, frameRate: 30, displaySurface: "browser" };
  stop = vi.fn(() => {
    this.readyState = "ended";
  });
  getSettings() {
    return this.settings;
  }
}
function media() {
  const track = new Track();
  const tracks = [track];
  const stream = {
    getTracks: () => tracks,
    getVideoTracks: () => tracks.filter((t) => t.kind === "video"),
    removeTrack: (t: Track) => tracks.splice(tracks.indexOf(t), 1),
  } as unknown as MediaStream;
  return { track, tracks, stream };
}
let instances: ScreenCapture[];
beforeEach(() => {
  vi.useFakeTimers();
  instances = [];
});
afterEach(() => {
  for (const capture of instances) capture.dispose();
  vi.useRealTimers();
  document.body.replaceChildren();
});
function rig() {
  const first = media();
  const driver: ScreenCaptureDriver = {
    capabilities: () => ({ screen: true, region: true, element: true }),
    acquire: vi.fn(async () => first.stream),
    applyTarget: vi.fn(async () => {}),
  };
  const capture = createScreenCapture({ driver });
  instances.push(capture);
  return { ...first, driver, capture };
}
function target(label = "chart") {
  const element = document.createElement("div");
  element.setAttribute("data-screen-capture-target", "");
  element.style.cssText = "isolation:isolate;transform-style:flat";
  element.getBoundingClientRect = () => ({ width: 100, height: 100 }) as DOMRect;
  document.body.append(element);
  return { element, label };
}

describe("screen capture ownership", () => {
  it("does not acquire until asked, reports live settings, and releases on stop", async () => {
    const { capture, driver, track, stream } = rig();
    expect(driver.acquire).not.toHaveBeenCalled();
    expect(capture.stream()).toBeUndefined();
    const updates = vi.fn();
    const off = capture.subscribe(updates);
    expect(updates).toHaveBeenCalledTimes(1);
    expect(await capture.start()).toBe(stream);
    expect(capture.snapshot()).toMatchObject({
      state: "active",
      settings: { width: 800 },
      source: { label: "Test tab" },
    });
    track.settings.width = 640;
    vi.advanceTimersByTime(500);
    expect(capture.snapshot().settings?.width).toBe(640);
    off();
    capture.stop();
    expect(capture.stream()).toBeUndefined();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("reacts to browser stop and mute/unmute", async () => {
    const { capture, track } = rig();
    await capture.start();
    track.muted = true;
    track.dispatchEvent(new Event("mute"));
    expect(capture.snapshot().muted).toBe(true);
    track.muted = false;
    track.dispatchEvent(new Event("unmute"));
    expect(capture.snapshot().muted).toBe(false);
    track.readyState = "ended";
    track.dispatchEvent(new Event("ended"));
    expect(capture.snapshot().state).toBe("idle");
    expect(vi.getTimerCount()).toBe(0);
  });
  it("releases a late permission grant after stop and disallows overlapping pickers", async () => {
    const { capture, driver, track, stream } = rig();
    const grant = deferred<MediaStream>();
    vi.mocked(driver.acquire).mockReturnValue(grant.promise);
    const started = capture.start();
    capture.stop();
    await expect(capture.start()).rejects.toThrow("pending");
    grant.resolve(stream);
    expect(await started).toBeUndefined();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(capture.snapshot()).toMatchObject({ state: "idle", requesting: false });
  });
  it("releases a late grant after disposal", async () => {
    const { capture, driver, track, stream } = rig();
    const grant = deferred<MediaStream>();
    vi.mocked(driver.acquire).mockReturnValue(grant.promise);
    const started = capture.start();
    capture.dispose();
    grant.resolve(stream);
    await started;
    expect(track.readyState).toBe("ended");
    await expect(capture.start()).rejects.toThrow("disposed");
  });
  it("keeps a previous session when replacement is declined, and retires it only on success", async () => {
    const { capture, driver, track, stream } = rig();
    await capture.start();
    vi.mocked(driver.acquire).mockRejectedValueOnce(
      new DOMException("Picker dismissed", "NotAllowedError"),
    );
    await expect(capture.start()).rejects.toThrow("dismissed");
    expect(capture.stream()).toBe(stream);
    expect(track.readyState).toBe("live");
    const next = media();
    vi.mocked(driver.acquire).mockResolvedValue(next.stream);
    await capture.start();
    expect(track.readyState).toBe("ended");
    expect(capture.stream()).toBe(next.stream);
    track.dispatchEvent(new Event("ended"));
    expect(capture.stream()).toBe(next.stream);
  });
  it("strips unexpected audio tracks from a custom driver", async () => {
    const { capture, tracks } = rig();
    const audio = new Track();
    audio.kind = "audio";
    tracks.push(audio);
    await capture.start();
    expect(audio.stop).toHaveBeenCalledOnce();
    expect(tracks).toHaveLength(1);
  });
});

describe("crop lifecycle", () => {
  it("rejects an undeclared boundary before acquisition and preserves an existing crop", async () => {
    const { capture, driver, track } = rig();
    const child = target("child");
    child.element.removeAttribute("data-screen-capture-target");
    await expect(capture.start({ target: { ...child, mode: "element" } })).rejects.toThrow(
      "declared capture boundary",
    );
    expect(driver.acquire).not.toHaveBeenCalled();
    await capture.start({ target: child });
    await expect(capture.setTarget({ ...child, mode: "element" })).rejects.toThrow(
      "declared capture boundary",
    );
    expect(driver.applyTarget).toHaveBeenCalledTimes(1);
    expect(capture.target()?.element).toBe(child.element);
    expect(capture.snapshot().crop?.mode).toBe("region");
    expect(track.readyState).toBe("live");
  });
  it("reports a boundary that loses its isolation without widening or mutating the capture", async () => {
    const { capture, driver } = rig();
    const area = { ...target(), mode: "element" as const };
    await capture.start({ target: area });
    area.element.style.isolation = "auto";
    vi.advanceTimersByTime(500);
    expect(capture.snapshot().crop).toMatchObject({
      available: false,
      unavailableReason: expect.stringContaining("isolation styles"),
    });
    area.element.style.isolation = "isolate";
    vi.advanceTimersByTime(500);
    expect(capture.snapshot().crop?.available).toBe(true);
    expect(driver.applyTarget).toHaveBeenCalledTimes(1);
  });
  it("withholds the first stream until the crop is applied", async () => {
    const { capture, driver, track, stream } = rig();
    const crop = deferred<void>();
    vi.mocked(driver.applyTarget).mockReturnValue(crop.promise);
    const started = capture.start({ target: target() });
    await Promise.resolve();
    expect(capture.stream()).toBeUndefined();
    expect(track.enabled).toBe(true);
    crop.resolve();
    await started;
    expect(capture.stream()).toBe(stream);
    expect(track.enabled).toBe(true);
    expect(capture.snapshot().crop).toEqual({ mode: "region", label: "chart", available: true });
  });
  it("stops a pending initial crop immediately without publishing it later", async () => {
    const { capture, driver, track } = rig();
    const crop = deferred<void>();
    vi.mocked(driver.applyTarget).mockReturnValue(crop.promise);
    const started = capture.start({ target: target() });
    await Promise.resolve();
    capture.stop();
    expect(track.readyState).toBe("ended");
    crop.resolve();
    await started;
    expect(capture.stream()).toBeUndefined();
    expect(capture.snapshot().state).toBe("idle");
  });
  it("serializes rapid target changes and passes the actual previous mode", async () => {
    const { capture, driver, track } = rig();
    await capture.start();
    const slow = deferred<void>();
    vi.mocked(driver.applyTarget).mockReturnValueOnce(slow.promise);
    const a = target("first");
    const b = { ...target("second"), mode: "element" as const };
    const first = capture.setTarget(a);
    const second = capture.setTarget(b);
    await Promise.resolve();
    expect(driver.applyTarget).toHaveBeenCalledTimes(1);
    expect(track.enabled).toBe(true);
    slow.resolve();
    await first;
    await second;
    expect(vi.mocked(driver.applyTarget).mock.calls[1]?.[2]).toBe("region");
    expect(capture.snapshot().crop?.label).toBe("second");
    await capture.setTarget(null);
    expect(vi.mocked(driver.applyTarget).mock.calls[2]?.[2]).toBe("element");
    expect(capture.snapshot().crop).toBeUndefined();
  });
  it("does not let a stale crop touch a replacement session", async () => {
    const { capture, driver, track } = rig();
    await capture.start();
    const slow = deferred<void>();
    vi.mocked(driver.applyTarget).mockReturnValueOnce(slow.promise);
    const crop = capture.setTarget(target());
    await Promise.resolve();
    capture.stop();
    const next = media();
    vi.mocked(driver.acquire).mockResolvedValue(next.stream);
    await capture.start();
    slow.resolve();
    await crop;
    expect(capture.stream()).toBe(next.stream);
    expect(capture.snapshot().crop).toBeUndefined();
    expect(track.readyState).toBe("ended");
  });
  it("closes capture when a native crop transition fails", async () => {
    const { capture, driver, track } = rig();
    await capture.start();
    vi.mocked(driver.applyTarget).mockRejectedValue(new Error("Not this tab"));
    await expect(capture.setTarget(target())).rejects.toThrow("Not this tab");
    expect(capture.stream()).toBeUndefined();
    expect(track.readyState).toBe("ended");
    expect(capture.snapshot()).toMatchObject({
      state: "error",
      cropping: false,
      error: "Capture stopped: Not this tab",
    });
  });
  it("rejects unsupported cropping before opening the picker", async () => {
    const { capture, driver } = rig();
    driver.capabilities = () => ({ screen: true, region: false, element: false });
    await expect(capture.start({ target: target() })).rejects.toThrow("unavailable");
    expect(driver.acquire).not.toHaveBeenCalled();
  });
  it("tracks hidden and removed targets without widening the crop", async () => {
    const { capture, driver } = rig();
    const area = target();
    await capture.start({ target: area });
    area.element.style.visibility = "hidden";
    vi.advanceTimersByTime(500);
    expect(capture.snapshot().crop?.available).toBe(false);
    area.element.style.visibility = "visible";
    vi.advanceTimersByTime(500);
    expect(capture.snapshot().crop?.available).toBe(true);
    area.element.remove();
    vi.advanceTimersByTime(500);
    expect(capture.snapshot().crop?.available).toBe(false);
    expect(driver.applyTarget).toHaveBeenCalledTimes(1);
  });
  it("does not acquire for an invalid frame rate", async () => {
    const { capture, driver } = rig();
    await expect(capture.start({ frameRate: Number.NaN })).rejects.toThrow("positive");
    expect(driver.acquire).not.toHaveBeenCalled();
  });
});

it("measures elapsed presentation rate, including frames between callbacks", () => {
  expect(frameRate({ time: 100, frames: 2 }, { time: 600, frames: 17 })).toBe(30);
  expect(frameRate({ time: 100, frames: 2 }, { time: 100, frames: 3 })).toBeUndefined();
  expect(frameRate({ time: 100, frames: 2 }, { time: 600, frames: 2 })).toBe(0);
});
