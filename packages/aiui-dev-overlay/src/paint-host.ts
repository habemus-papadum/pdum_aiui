/**
 * The overlay's paint-host wiring: when the channel hosts the **paint sidecar**
 * (on by default in `aiui claude`), connect this page as a paint host so an
 * iPad can view it and draw into the intent tool.
 *
 * The multimodal modality publishes two seams on `window.__AIUI__` (see
 * instrumentation.ts), and this module is the other half of both:
 *
 *  - `remotePaint` — arming from the iPad arms the intent turn, and remote
 *    strokes land on the same ink layer local drawing uses.
 *  - `displayCapture` — the document's ONE `getDisplayMedia` grant. The iPad's
 *    video streams from the same MediaStream the screenshots grab frames from.
 *    A grant belongs to a *document*, not to a client or a port: a second call
 *    doesn't reuse the first, it opens a second independent stream. So the page
 *    asks once, and everyone reads it.
 *
 * Mirrors the session bus's shape: probe before dialing (`GET /paint/info` —
 * only a channel with the sidecar answers), no-op without a channel port, and
 * a disposer that tears everything down. The seams may be installed after us
 * (mount order), so we poll briefly for them.
 *
 * The "Share screen with iPad" button is the fallback, not the path. In the
 * session browser `getDisplayMedia` is auto-accepted (see the capture marker),
 * so a viewer joining acquires the grant off that network event and no button
 * ever appears. In a browser that would open a picker, capture reports
 * `needsGesture` and the button appears to supply the click.
 */
import { startPaintHost } from "@habemus-papadum/aiui-paint";
import { getInstrumentation, type PageInstrumentation } from "./instrumentation";
import { paintFrameSource } from "./multimodal/display-capture";
import { canvasJpegBytes } from "./multimodal/shot";

export interface PaintHostOptions {
  /** Channel port; defaults to the plugin-injected `window.__AIUI__.port`. */
  port?: number;
  /** Human label for the iPad's session list; defaults to `document.title`. */
  label?: string;
}

const SEAM_POLL_MS = 250;
const SEAM_POLL_TRIES = 40; // ~10s — the modality mounts on page load

function resolvePort(option: number | undefined): number | undefined {
  const injected = typeof window === "undefined" ? undefined : window.__AIUI__?.port;
  const port = Number(option ?? injected);
  return Number.isInteger(port) && port > 0 ? port : undefined;
}

/**
 * Connect this page as a paint host when the channel runs the paint sidecar.
 * Safe to call unconditionally: resolves to a no-op disposer without a DOM, a
 * channel port, a `/paint`-capable channel, or the intent tool's ink seam.
 */
export function installPaintHost(opts: PaintHostOptions = {}): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return () => {};
  }
  const port = resolvePort(opts.port);
  if (port === undefined) {
    return () => {};
  }

  let disposed = false;
  let disposeHost: (() => void) | undefined;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let shareBtn: HTMLButtonElement | undefined;
  let shareTimer: ReturnType<typeof setInterval> | undefined;

  const base = `http://127.0.0.1:${port}/paint`;

  // Probe, then wait for the ink seam, then start the host.
  void (async () => {
    try {
      // Two-stage for console hygiene, like the session bus's /health probe.
      await fetch(`${base}/info`, { mode: "no-cors" });
      const res = await fetch(`${base}/info`);
      if (!res.ok) {
        return;
      }
    } catch {
      return; // no channel, or no paint sidecar — nothing to wire
    }
    if (disposed) {
      return;
    }

    const findSeam = (triesLeft: number): void => {
      if (disposed) {
        return;
      }
      const inst = getInstrumentation();
      if (inst?.remotePaint) {
        start(inst);
        return;
      }
      if (triesLeft > 0) {
        pollTimer = setTimeout(() => findSeam(triesLeft - 1), SEAM_POLL_MS);
      }
    };
    findSeam(SEAM_POLL_TRIES);
  })();

  const start = (inst: PageInstrumentation): void => {
    const sink = inst.remotePaint;
    if (!sink) {
      return;
    }
    // Both seams are published by the same mount, so `displayCapture` is here
    // whenever `remotePaint` is. Absent (a page with no intent tool), paint
    // falls back to its own getDisplayMedia — its default frame source.
    const grant = inst.displayCapture;
    const host = startPaintHost({
      relayUrl: base,
      // RemotePaintSink and aiui-paint's InkSink agree by shape (the packages
      // deliberately don't import each other — see instrumentation.ts); so do
      // the broker's frame source and aiui-paint's FrameSource.
      ink: sink,
      label: opts.label ?? document.title,
      channelPort: port,
      ...(grant ? { frameSource: paintFrameSource(grant, canvasJpegBytes) } : {}),
    });

    // The "share screen" affordance: in a browser that opens a picker,
    // getDisplayMedia needs a real click, and a viewer joining is a network
    // event. Poll the cheap host getters and show a button while a viewer is
    // waiting on the gesture — and KEEP it up after a failed attempt
    // ("denied"), with the failure in the label: a click that silently made the
    // button vanish while the capture had actually thrown (wrong browser flags,
    // a missing OS grant) cost a real debugging session. Where capture is
    // auto-accepted the state goes straight to "active" and this never fires.
    shareTimer = setInterval(() => {
      const state = host.captureState();
      const wanted = host.viewers() > 0 && (state === "needsGesture" || state === "denied");
      if (wanted && !shareBtn) {
        shareBtn = document.createElement("button");
        shareBtn.type = "button";
        shareBtn.setAttribute(
          "style",
          [
            "position:fixed",
            "right:16px",
            "bottom:16px",
            "z-index:2147483646",
            "padding:10px 14px",
            "border-radius:12px",
            "border:1px solid #2a3040",
            "background:#161a22",
            "color:#e8ebf0",
            "font:14px/-apple-system, system-ui, sans-serif",
            "cursor:pointer",
            "box-shadow:0 4px 18px rgba(0,0,0,0.4)",
            "max-width:340px",
            "text-align:left",
            "white-space:pre-line",
          ].join(";"),
        );
        shareBtn.addEventListener("click", () => {
          void host.requestCapture().then((result) => {
            if (result !== "active") {
              console.warn(
                `[aiui] screen share did not start (${result})${host.captureError() ? ` — ${host.captureError()}` : ""}`,
              );
            }
          });
        });
        document.body.appendChild(shareBtn);
      } else if (!wanted && shareBtn) {
        shareBtn.remove();
        shareBtn = undefined;
      }
      if (shareBtn) {
        const error = host.captureError();
        const label =
          state === "denied"
            ? `⚠️ Screen share failed — click to retry${error !== undefined ? `\n${error}` : ""}`
            : "📺 Share screen with iPad";
        if (shareBtn.textContent !== label) {
          shareBtn.textContent = label;
        }
      }
    }, 1000);

    disposeHost = () => {
      if (shareTimer) {
        clearInterval(shareTimer);
      }
      shareBtn?.remove();
      shareBtn = undefined;
      // host.close() stops its frame source. When that source is the shared
      // grant, stopping it is a no-op by design — the shot tool still holds it,
      // and only the modality's unmount ends it.
      host.close();
    };
  };

  return () => {
    disposed = true;
    if (pollTimer) {
      clearTimeout(pollTimer);
    }
    disposeHost?.();
  };
}
