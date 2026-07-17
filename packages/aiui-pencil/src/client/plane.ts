/**
 * plane.ts — the pencil plane (D2): the video's CONTENT box, not the stage.
 *
 * WebRTC ramps resolution from a tiny first frame, and each change fires
 * `resize` on the video element — a plane computed from anything else
 * silently keeps its stale default (measured: strokes y-compressed by exactly
 * the letterbox ratio). So the tracker recomputes from the video's intrinsic
 * size against the stage, and the caller MUST wire `recompute` to the video
 * element's own `resize`/`loadedmetadata` events (attaching from the stage's
 * ref was a bet on ref ordering, and it lost).
 */

export interface PlaneBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PlaneTracker {
  /** The current content box, stage-relative CSS px. */
  box(): PlaneBox;
  /** Re-derive the box and re-position the plane element. */
  recompute(): void;
}

export function createPlaneTracker(els: {
  stage: () => HTMLElement | undefined;
  video: () => HTMLVideoElement | undefined;
  plane: () => HTMLElement | undefined;
}): PlaneTracker {
  let planeBox: PlaneBox = { left: 0, top: 0, width: 1, height: 1 };

  const recompute = (): void => {
    const stage = els.stage();
    const video = els.video();
    const plane = els.plane();
    if (!stage || !video || !plane) {
      return;
    }
    const sw = stage.clientWidth;
    const sh = stage.clientHeight;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (vw > 0 && vh > 0) {
      const scale = Math.min(sw / vw, sh / vh);
      const width = vw * scale;
      const height = vh * scale;
      planeBox = { left: (sw - width) / 2, top: (sh - height) / 2, width, height };
    } else {
      planeBox = { left: 0, top: 0, width: Math.max(1, sw), height: Math.max(1, sh) };
    }
    plane.style.left = `${planeBox.left}px`;
    plane.style.top = `${planeBox.top}px`;
    plane.style.width = `${planeBox.width}px`;
    plane.style.height = `${planeBox.height}px`;
  };

  return { box: () => planeBox, recompute };
}
