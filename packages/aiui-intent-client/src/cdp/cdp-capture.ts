/**
 * cdp-capture.ts — the CdpBus's CaptureSource: stills off `Page.captureScreenshot`,
 * no grant and no MediaStream. Split out of cdp-bus.ts; it owns no shared state,
 * reaching the page registry through one `pageFor` lookup callback.
 *
 * Panel-side only. Never import this from page-script.ts / page-bundle.ts: those
 * are stringified/evaluated INTO arbitrary pages and must stay dependency-free.
 */
import type { CaptureSource, HeldStream, PanelShot } from "../transport";
import type { AttachedPage } from "./cdp-bus";

export interface CdpCaptureDeps {
  /** cdp.send, bound (the ScreencastDeps shape). */
  send(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<Record<string, unknown>>;
  /** The attached page for a driver tab, or undefined when it is gone. */
  pageFor(tab: number): AttachedPage | undefined;
}

/** Width/height from a PNG's IHDR (8-byte signature, then a length+type header,
 * then two big-endian uint32s). Returns undefined if the bytes are not a PNG we
 * can read — the caller then falls back to its own estimate. */
function pngSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  // 8 sig + 4 length + 4 "IHDR" = 16, then width@16, height@20.
  if (bytes.length < 24 || bytes[0] !== 0x89 || bytes[1] !== 0x50) {
    return undefined;
  }
  const u32 = (o: number) =>
    ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0;
  return { width: u32(16), height: u32(20) };
}

export function createCdpCapture({ send, pageFor }: CdpCaptureDeps): CaptureSource {
  return {
    // `Page.captureScreenshot` asks nobody: any attached tab, no grant, no
    // MediaStream. So the shot/selection acts light up as soon as a turn is
    // open, and they follow the tab you are looking at.
    grantless: true,
    // Nothing to warm, either — the "held stream" is a handle the claim's
    // lifecycle can still hold.
    holdStream: (tab) => Promise.resolve<HeldStream>({ tab, release: () => {} }),
    grabShot: async (tab): Promise<PanelShot> => {
      const page = pageFor(tab);
      if (page === undefined) {
        throw new Error(`no attached page for tab ${tab}`);
      }
      const shot = (await send(
        "Page.captureScreenshot",
        { format: "png", captureBeyondViewport: false },
        page.sessionId,
      )) as { data?: string };
      if (typeof shot.data !== "string") {
        throw new Error("Page.captureScreenshot returned no data");
      }
      const bytes = Uint8Array.from(atob(shot.data), (c) => c.charCodeAt(0));
      const metrics = (await send("Page.getLayoutMetrics", {}, page.sessionId)) as {
        cssVisualViewport?: { clientWidth?: number; clientHeight?: number };
      };
      return {
        width: Math.round(metrics.cssVisualViewport?.clientWidth ?? 0),
        height: Math.round(metrics.cssVisualViewport?.clientHeight ?? 0),
        mime: "image/png",
        bytes,
        thumb: `data:image/png;base64,${shot.data}`,
      };
    },
    grabRegion: async (tab, rect): Promise<PanelShot> => {
      const page = pageFor(tab);
      if (page === undefined) {
        throw new Error(`no attached page for tab ${tab}`);
      }
      // `Page.captureScreenshot`'s clip is NOT in the page's (zoomed) CSS pixels —
      // it is in UNZOOMED device-independent pixels, so under a non-100% browser
      // zoom it silently disagrees with the rubber band, which reports `clientX`/
      // `innerWidth` (both zoomed). The old "no scale math to get wrong" assumption
      // held only at zoom 1; at zoom Z the clip captured 1/Z of the region and put
      // it in the wrong place (found live at zoom 1.5 — the crop was the top-left
      // ⅔, offset). Multiply the rect by the live zoom to land the clip. `scale: 1`
      // then already yields full device resolution (clip · deviceScaleFactor, and
      // zoom · deviceScaleFactor === devicePixelRatio), so the pixels match a
      // full-frame `grabShot`. At zoom 1 this is a no-op.
      const metrics = (await send("Page.getLayoutMetrics", {}, page.sessionId)) as {
        cssVisualViewport?: { zoom?: number };
      };
      const zoom = metrics.cssVisualViewport?.zoom ?? 1;
      const shot = (await send(
        "Page.captureScreenshot",
        {
          format: "png",
          captureBeyondViewport: false,
          clip: {
            x: rect.x * zoom,
            y: rect.y * zoom,
            width: rect.w * zoom,
            height: rect.h * zoom,
            scale: 1,
          },
        },
        page.sessionId,
      )) as { data?: string };
      if (typeof shot.data !== "string") {
        throw new Error("Page.captureScreenshot returned no data");
      }
      const bytes = Uint8Array.from(atob(shot.data), (c) => c.charCodeAt(0));
      // Report the shot's true pixel size (from the PNG's IHDR), not the CSS rect —
      // the encoded image is device-resolution, so its dims are `rect · dpr`.
      const size = pngSize(bytes);
      return {
        width: size?.width ?? Math.round(rect.w),
        height: size?.height ?? Math.round(rect.h),
        mime: "image/png",
        bytes,
        thumb: `data:image/png;base64,${shot.data}`,
      };
    },
  };
}
