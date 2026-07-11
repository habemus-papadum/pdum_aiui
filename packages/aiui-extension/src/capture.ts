/**
 * Shot-capture wire shapes + pure helpers, shared by the panel (orchestration)
 * and the service worker (plumbing). The pixel work itself happens in the
 * static offscreen document (`public/offscreen.js`), which answers these same
 * shapes over the kit relay — see that file for why it ships verbatim instead
 * of being bundled.
 */

/** The panel's ask: one frame of `tabId`, sized to the tab's own viewport.
 * `width`/`height` are CSS px (the page's `innerWidth`/`innerHeight`);
 * `dpr` its `devicePixelRatio`. The constraints matter: an unconstrained
 * tabCapture track defaults to display-sized crop-and-scale output
 * (measured — extension-spikes RESULTS.md M1/M2). */
export interface CaptureRequest {
  tabId: number;
  width: number;
  height: number;
  dpr: number;
}

/** What the offscreen grab returns: the full frame as a PNG data URL (the
 * attachment upload decodes it), a small JPEG thumb for inline previews, and
 * the frame's actual pixel dimensions. Data URLs, not bytes, because relay
 * messages are JSON — typed arrays don't survive `chrome.runtime` messaging. */
export interface ShotGrab {
  png: string;
  thumb: string;
  width: number;
  height: number;
}

/** Decode a data URL's base64 body to raw bytes (the attachment upload's form). */
export function dataUrlToBytes(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(",");
  if (comma === -1) {
    throw new Error("malformed data URL (no payload)");
  }
  const binary = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * The tabCapture invocation gate, recognized by its measured error string
 * (RESULTS.md M4a): "Extension has not been invoked for the current page
 * (see activeTab permission). Chrome pages cannot be captured." The remedy is
 * an action click on that tab, so the status line must say exactly that.
 */
export function isNotInvokedError(message: string): boolean {
  return /has not been invoked/i.test(message);
}
