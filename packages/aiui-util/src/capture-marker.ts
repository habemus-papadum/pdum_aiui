/**
 * Tell the pages of a session browser that display capture is auto-accepted
 * there, by defining `window.__AIUI_CAPTURE__ = "auto"` in every document.
 *
 * ## Why a page cannot work this out for itself
 *
 * `launchSessionBrowser` passes `--auto-accept-this-tab-capture`, so in *that*
 * browser `getDisplayMedia({ preferCurrentTab: true })` resolves with no user
 * gesture and no picker. In a browser without the flag, the same call opens the
 * share picker and the promise **hangs** until a human answers it — with or
 * without transient activation. It does not reject, and it takes no
 * `AbortSignal`. So the obvious design ("try it; if it fails, show a button")
 * is unavailable: there is no failure to catch, only a dialog nobody asked for.
 *
 * Nor is the flag detectable. `navigator.permissions.query({ name:
 * "display-capture" })` answers `"prompt"` in both browsers — display capture
 * is not a persistable permission, it is a per-call grant — and no other
 * surface reflects the launch flags (all measured, July 2026).
 *
 * ## Why CDP, and not the extension or the channel
 *
 * The fact being communicated is a property of **this browser process**, so the
 * marker has to be scoped to it. Two tempting alternatives leak:
 *
 *  - A content script in the aiui DevTools extension travels with the
 *    *profile*, and the extension is also installed by hand into people's
 *    personal Chrome (the autoload hint tells them to). It would then promise
 *    auto-capture in a browser that hangs.
 *  - A flag on the channel's `/health` travels with the *port*, and a personal
 *    Chrome can open the same loopback page.
 *
 * A CDP connection to the endpoint we launched *is* the browser process, exactly.
 *
 * ## Lifetime
 *
 * `Page.addScriptToEvaluateOnNewDocument` lives on a CDP session and dies with
 * it, so the marker holds only while this connection is open. That is the
 * honest scope: `aiui vite` serves the pages that read the marker, so it is the
 * process that installs it. If it exits, later documents simply see no marker
 * and fall back to asking for a click — the pre-marker behavior, never a hang.
 *
 * @see `packages/aiui-dev-overlay/src/multimodal/display-capture.ts` — the reader.
 */

/** What we define in every document of a browser launched with auto-accept. */
export const CAPTURE_MARKER_SOURCE = 'window.__AIUI_CAPTURE__ = "auto";';

/** How long the browser gets to answer `/json/version` and open its socket. */
const CONNECT_TIMEOUT_MS = 5_000;

interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
}

interface TargetInfo {
  targetId: string;
  type: string;
}

/**
 * Chrome reports its browser socket as `ws://127.0.0.1:<its own port>/…`, which
 * is a lie from anywhere but that machine — a tunneled remote browser
 * (docs/guide/remote) is reached at the forwarded host:port we just fetched
 * from. Keep the path (the browser's session id) and take the authority from
 * the endpoint that answered.
 */
export function rehostSocketUrl(webSocketDebuggerUrl: string, browserUrl: string): string {
  const socket = new URL(webSocketDebuggerUrl);
  const endpoint = new URL(browserUrl);
  socket.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
  // hostname + port, never `host`: assigning a host with no port component
  // leaves the OLD port in place, so a default-port endpoint would inherit
  // Chrome's self-reported one.
  socket.hostname = endpoint.hostname;
  socket.port = endpoint.port;
  return socket.toString();
}

/**
 * Attach to `browserUrl` and keep every page target marked: documents already
 * open are marked now, documents opened later are marked as they attach.
 * Returns a disposer that closes the connection (after which new documents get
 * no marker).
 *
 * Throws if the endpoint can't be reached — callers treat that as a warning,
 * not a failure: an unmarked browser is still a working browser.
 */
export async function installCaptureMarker(browserUrl: string): Promise<() => void> {
  const base = browserUrl.replace(/\/+$/, "");
  const res = await fetch(`${base}/json/version`, {
    signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`the browser's DevTools endpoint answered ${res.status} ${res.statusText}`);
  }
  const { webSocketDebuggerUrl } = (await res.json()) as { webSocketDebuggerUrl?: string };
  if (!webSocketDebuggerUrl) {
    throw new Error("the browser's DevTools endpoint exposes no webSocketDebuggerUrl");
  }

  const socket = new WebSocket(rehostSocketUrl(webSocketDebuggerUrl, base));
  /** Ids of `Target.getTargets` calls whose reply we still owe an adoption pass. */
  const enumerations = new Set<number>();
  let nextId = 1;

  const send = (method: string, params: object = {}, sessionId?: string): number => {
    const id = nextId++;
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return id;
  };

  /**
   * Mark one attached page. `addScriptToEvaluateOnNewDocument` covers every
   * future navigation (including Vite's reloads); `Runtime.evaluate` covers the
   * document already loaded — a page opened before we attached would otherwise
   * have to wait for its first reload to learn where it is.
   */
  const markPage = (sessionId: string): void => {
    send("Page.addScriptToEvaluateOnNewDocument", { source: CAPTURE_MARKER_SOURCE }, sessionId);
    send("Runtime.evaluate", { expression: CAPTURE_MARKER_SOURCE }, sessionId);
  };

  // Listen before connecting: Target.attachedToTarget for the tabs already open
  // can arrive in the same tick the socket opens.
  socket.addEventListener("message", (event: MessageEvent) => {
    let message: CdpMessage;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (message.method === "Target.attachedToTarget") {
      const sessionId = message.params?.sessionId;
      const targetInfo = message.params?.targetInfo as TargetInfo | undefined;
      if (typeof sessionId === "string" && targetInfo?.type === "page") {
        markPage(sessionId);
      }
      return;
    }
    if (message.id !== undefined && enumerations.delete(message.id)) {
      const targets = (message.result?.targetInfos ?? []) as TargetInfo[];
      for (const target of targets) {
        if (target.type === "page") {
          // Attaching fires Target.attachedToTarget above, which does the marking.
          send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
        }
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("timed out connecting to the browser's DevTools socket")),
      CONNECT_TIMEOUT_MS,
    );
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("could not open the browser's DevTools socket"));
    });
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      // Flat mode: one socket, sessions addressed by `sessionId` on each message
      // rather than the legacy Target.sendMessageToTarget nesting.
      // waitForDebuggerOnStart would pause every new page until we resumed it —
      // we want to inject, never to gate the page's own startup.
      send("Target.setAutoAttach", {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
      });
      // setAutoAttach only covers targets created from now on, so adopt the tabs
      // already open (the startUrl tab, anything the user left behind).
      enumerations.add(send("Target.getTargets"));
      resolve();
    });
  });

  return () => socket.close();
}
