import { afterEach, expect, it, vi } from "vitest";
import { observePreview } from "./preview";

afterEach(() => vi.useRealTimers());

it("distinguishes missing initial frames from a still image and recovers on delivery", () => {
  vi.useFakeTimers();
  const video = document.createElement("video");
  let frame!: VideoFrameRequestCallback;
  video.requestVideoFrameCallback = vi.fn((callback) => {
    frame = callback;
    return 1;
  });
  video.cancelVideoFrameCallback = vi.fn();
  const report = vi.fn();
  const stop = observePreview(video, report);
  vi.advanceTimersByTime(2000);
  expect(report).toHaveBeenLastCalledWith(expect.objectContaining({ frames: "empty" }));
  frame(performance.now(), { presentedFrames: 1 } as VideoFrameCallbackMetadata);
  expect(report).toHaveBeenLastCalledWith(expect.objectContaining({ frames: "ready" }));
  vi.advanceTimersByTime(2000);
  expect(report).toHaveBeenLastCalledWith(expect.objectContaining({ frames: "ready", fps: 0 }));
  stop();
  expect(vi.getTimerCount()).toBe(0);
  expect(video.cancelVideoFrameCallback).toHaveBeenCalledWith(1);
});

it("uses video readiness when frame callbacks are unavailable", () => {
  vi.useFakeTimers();
  const video = document.createElement("video");
  Object.defineProperty(video, "readyState", { value: 2 });
  const report = vi.fn();
  const stop = observePreview(video, report);
  vi.advanceTimersByTime(2000);
  expect(report).toHaveBeenLastCalledWith(
    expect.objectContaining({ frames: "ready", fps: undefined }),
  );
  stop();
});
