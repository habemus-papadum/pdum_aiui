import { elementCaptureIssue } from "./targets";
import type {
  CaptureCapabilities,
  CaptureOptions,
  CaptureTarget,
  CropMode,
  ScreenCaptureDriver,
} from "./types";

type TargetFactory = { fromElement(element: Element): Promise<unknown> };
type CaptureGlobals = typeof globalThis & {
  CropTarget?: TargetFactory;
  RestrictionTarget?: TargetFactory;
  BrowserCaptureMediaStreamTrack?: { prototype: NativeCaptureTrack };
};
interface NativeCaptureTrack extends MediaStreamTrack {
  cropTo?(target: unknown): Promise<void>;
  restrictTo?(target: unknown): Promise<void>;
}

export function screenCaptureCapabilities(): CaptureCapabilities {
  const env = globalThis as CaptureGlobals;
  const prototype = env.BrowserCaptureMediaStreamTrack?.prototype;
  return {
    screen:
      typeof navigator !== "undefined" &&
      typeof navigator.mediaDevices?.getDisplayMedia === "function",
    region: !!env.CropTarget?.fromElement && typeof prototype?.cropTo === "function",
    element: !!env.RestrictionTarget?.fromElement && typeof prototype?.restrictTo === "function",
  };
}

/** Browser-native capture; no canvas copy, network connection, or DOM rasterizer. */
export function browserScreenCaptureDriver(): ScreenCaptureDriver {
  const tokens = {
    region: new WeakMap<Element, Promise<unknown>>(),
    element: new WeakMap<Element, Promise<unknown>>(),
  };
  function token(target: CaptureTarget, mode: CropMode): Promise<unknown> {
    let result = tokens[mode].get(target.element);
    if (!result) {
      const env = globalThis as CaptureGlobals;
      const factory = mode === "region" ? env.CropTarget : env.RestrictionTarget;
      if (!factory)
        throw new Error(
          `${mode === "region" ? "Region" : "Element"} capture is unavailable in this browser.`,
        );
      result = factory.fromElement(target.element);
      tokens[mode].set(target.element, result);
      void result.catch(() => tokens[mode].delete(target.element));
    }
    return result;
  }
  return {
    capabilities: screenCaptureCapabilities,
    acquire(options: CaptureOptions) {
      if (!screenCaptureCapabilities().screen) {
        throw new Error("Screen capture requires a supported browser on HTTPS or localhost.");
      }
      // No await before getDisplayMedia: preserve the caller's transient user activation.
      const constraints = {
        video: { frameRate: { ideal: options.frameRate ?? 30 } },
        audio: false,
        preferCurrentTab: options.target ? true : (options.preferCurrentTab ?? false),
        selfBrowserSurface: "include",
        surfaceSwitching: "exclude",
      };
      return navigator.mediaDevices.getDisplayMedia(constraints);
    },
    async applyTarget(track, target, previous) {
      const native = track as NativeCaptureTrack;
      const mode = target?.mode ?? "region";
      if (target && mode === "element") {
        const issue = elementCaptureIssue(target.element);
        if (issue) throw new Error(issue);
      }
      const nextToken = target ? await token(target, mode) : null;
      if (track.readyState !== "live")
        throw new Error("The capture ended before cropping finished.");
      if (target && track.getSettings().displaySurface !== "browser") {
        throw new Error(
          "To capture an element, share this browser tab rather than a window or display.",
        );
      }
      if (target && typeof (mode === "region" ? native.cropTo : native.restrictTo) !== "function") {
        throw new Error("This captured source does not support the selected crop mode.");
      }
      // Native targets replace each other atomically. Do not uncrop first or toggle
      // track.enabled: that introduces an unnecessary full-surface/black-frame transition.
      if (target) {
        if (mode === "region") await native.cropTo?.(nextToken);
        else await native.restrictTo?.(nextToken);
      } else if (previous === "region") await native.cropTo?.(null);
      else if (previous === "element") await native.restrictTo?.(null);
    },
  };
}
