/**
 * The overlay's paint-host wiring: when the channel hosts the **paint sidecar**
 * (`aiui claude --aiui-sidecar paint`), connect this page as a paint host so an
 * iPad can view it and draw into the intent tool.
 *
 * The multimodal modality publishes the ink seam (`window.__AIUI__.remotePaint`
 * — see instrumentation.ts): arming from the iPad arms the intent turn, and
 * remote strokes land on the same ink layer local drawing uses. This module
 * supplies the other half nothing else owns in the channel flow: *starting* the
 * `aiui-paint` host against the channel's `/paint` routes.
 *
 * Mirrors the session bus's shape: probe before dialing (`GET /paint/info` —
 * only a channel with the sidecar answers), no-op without a channel port, and
 * a disposer that tears everything down. The remotePaint seam may be installed
 * after us (mount order), so we poll briefly for it.
 *
 * Screen capture needs a user gesture (`getDisplayMedia`); when a viewer is
 * waiting on one, this module shows a small fixed "Share screen with iPad"
 * button and hides it once capture starts (or every viewer leaves).
 */
import { startPaintHost } from "@habemus-papadum/aiui-paint";
import { getInstrumentation } from "./instrumentation";

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
      const sink = getInstrumentation()?.remotePaint;
      if (sink) {
        start(sink);
        return;
      }
      if (triesLeft > 0) {
        pollTimer = setTimeout(() => findSeam(triesLeft - 1), SEAM_POLL_MS);
      }
    };
    findSeam(SEAM_POLL_TRIES);
  })();

  const start = (sink: NonNullable<ReturnType<typeof getInstrumentation>>["remotePaint"]): void => {
    if (!sink) {
      return;
    }
    const host = startPaintHost({
      relayUrl: base,
      // RemotePaintSink and aiui-paint's InkSink agree by shape (the packages
      // deliberately don't import each other — see instrumentation.ts).
      ink: sink,
      label: opts.label ?? document.title,
      channelPort: port,
    });

    // The "share screen" affordance: getDisplayMedia needs a real click, and a
    // viewer joining is a network event. Poll the cheap host getters and show a
    // button exactly while a viewer is waiting on the gesture.
    shareTimer = setInterval(() => {
      const wanted = host.viewers() > 0 && host.captureState() === "needsGesture";
      if (wanted && !shareBtn) {
        shareBtn = document.createElement("button");
        shareBtn.type = "button";
        shareBtn.textContent = "📺 Share screen with iPad";
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
          ].join(";"),
        );
        shareBtn.addEventListener("click", () => {
          void host.requestCapture();
        });
        document.body.appendChild(shareBtn);
      } else if (!wanted && shareBtn) {
        shareBtn.remove();
        shareBtn = undefined;
      }
    }, 1000);

    disposeHost = () => {
      if (shareTimer) {
        clearInterval(shareTimer);
      }
      shareBtn?.remove();
      shareBtn = undefined;
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
