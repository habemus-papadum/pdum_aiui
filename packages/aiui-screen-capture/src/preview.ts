import { frameRate } from "./model";

export interface PreviewStats {
  width: number;
  height: number;
  fps?: number;
  /** Initial delivery only: a static image is still ready even if its FPS falls to zero. */
  frames: "waiting" | "ready" | "empty";
}

/** Measures this preview's presentation cadence, not the source's nominal frame rate. */
export function observePreview(
  video: HTMLVideoElement,
  report: (stats: PreviewStats) => void,
): () => void {
  let callback = 0;
  let previous: { time: number; frames: number } | undefined;
  let lastFrame = performance.now();
  let stopped = false;
  let received = false;
  const supported = typeof video.requestVideoFrameCallback === "function";
  const publish = (fps?: number) =>
    report({
      width: video.videoWidth,
      height: video.videoHeight,
      fps,
      frames: received
        ? "ready"
        : !video.ownerDocument.hidden && performance.now() - lastFrame > 1500
          ? "empty"
          : "waiting",
    });
  const onFrame: VideoFrameRequestCallback = (now, metadata) => {
    if (stopped) return;
    lastFrame = now;
    if (!received) {
      received = true;
      publish();
    }
    const next = { time: now, frames: metadata.presentedFrames };
    if (!previous) previous = next;
    if (now - previous.time >= 500) {
      publish(video.ownerDocument.hidden ? undefined : frameRate(previous, next));
      previous = next;
    }
    callback = video.requestVideoFrameCallback(onFrame);
  };
  if (supported) callback = video.requestVideoFrameCallback(onFrame);
  const timer = setInterval(() => {
    if (!supported && video.readyState >= 2) received = true;
    if (video.ownerDocument.hidden || !supported || performance.now() - lastFrame > 1500) {
      previous = undefined;
      publish(video.ownerDocument.hidden || !supported ? undefined : 0);
    }
  }, 500);
  return () => {
    stopped = true;
    clearInterval(timer);
    if (supported) video.cancelVideoFrameCallback(callback);
  };
}
