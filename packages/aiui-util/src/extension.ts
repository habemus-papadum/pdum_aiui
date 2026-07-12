/**
 * Talking to an unpacked extension in the session browser, over raw CDP:
 * reload it, and ask it what it is actually running.
 *
 * `chrome.runtime.reload()` is the only thing that makes Chrome re-read an
 * unpacked extension's directory — which is exactly what the CRXJS dev loop
 * needs after every dev-server start (the artifact on disk was just rewritten;
 * Chrome is still holding the previous run's snapshot). Doing it by hand means
 * a trip to chrome://extensions and a click; doing it in the wrong order —
 * while Vite is still writing — is what strands people with a blank panel. So
 * the CLI owns it: wait for the artifact, reload, then *verify* by reading the
 * extension's own dev stamp back out of the browser.
 *
 * Chrome exposes no HTTP verb for any of this, but every extension context can
 * call `chrome.runtime.reload()` and `fetch(chrome.runtime.getURL(…))` itself,
 * and the DevTools protocol can evaluate in any of them. Two ways in, in order:
 *
 *  1. **An existing extension target** — the MV3 service worker, or any open
 *     extension page. Cheap and invisible.
 *  2. **A wake page** — MV3 service workers idle-terminate (~30s), so quite
 *     often there is *no* extension target at all. We then open one of the
 *     extension's own pages in a background tab, evaluate there, and close it.
 *     The extension supplies a page that is safe to open for this purpose
 *     (aiui-extension ships `reload.html`, which is inert).
 */

/** A DevTools target as listed by `GET /json/list`. */
export interface BrowserTarget {
  id: string;
  type: string;
  url: string;
  title?: string;
  webSocketDebuggerUrl?: string;
}

/** How to reach a context inside one extension. */
export interface ExtensionContextOptions {
  /** The extension id (aiui's is pinned by the manifest key). */
  extensionId: string;
  /**
   * An inert page inside the extension, opened in a background tab when no
   * extension context exists to evaluate in. Without it, a sleeping service
   * worker means "not-loaded".
   */
  wakePage?: string;
  /** How long to wait for a reply. */
  timeoutMs?: number;
}

/** Why we couldn't run something inside the extension. */
export type ExtensionFailure =
  /** The browser has no context for this extension — it isn't loaded. */
  | { ok: false; reason: "not-loaded" }
  /** The browser's debug endpoint didn't answer. */
  | { ok: false; reason: "no-browser"; detail: string }
  /** We reached a context, but the expression threw in it. */
  | { ok: false; reason: "failed"; detail: string };

export type ReloadExtensionResult =
  | { ok: true; via: "service-worker" | "page" | "wake-page" }
  | ExtensionFailure;

export type EvaluateInExtensionResult<T> = { ok: true; value: T } | ExtensionFailure;

/** `GET /json/list` — every target the browser is willing to show us. */
export async function listBrowserTargets(browserUrl: string): Promise<BrowserTarget[]> {
  const res = await fetch(`${trim(browserUrl)}/json/list`, {
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) {
    throw new Error(`the browser's debug endpoint answered ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as BrowserTarget[];
}

/** Targets belonging to one extension (service worker, pages, offscreen docs). */
export function extensionTargets(targets: BrowserTarget[], extensionId: string): BrowserTarget[] {
  const prefix = `chrome-extension://${extensionId}/`;
  return targets.filter((t) => t.url.startsWith(prefix));
}

/**
 * Make the browser re-read the extension's directory.
 *
 * The evaluation destroys the context it runs in, so the reply never arrives —
 * "no answer" is success here, not failure. Callers that need certainty read
 * the extension back afterwards ({@link evaluateInExtension}).
 */
export async function reloadExtension(
  browserUrl: string,
  options: ExtensionContextOptions,
): Promise<ReloadExtensionResult> {
  const context = await extensionContext(browserUrl, options);
  if (!context.ok) {
    return context;
  }
  const threw = await evaluate(
    context.socket,
    "chrome.runtime.reload()",
    options.timeoutMs ?? 2000,
    false,
  );
  await context.release();
  // A wake page that failed to load answers with an exception instead of dying:
  // that means the extension isn't there, not that the reload broke.
  if (threw.threw) {
    return context.via === "wake-page"
      ? { ok: false, reason: "not-loaded" }
      : { ok: false, reason: "failed", detail: threw.threw };
  }
  return { ok: true, via: context.via };
}

/**
 * Run an expression *inside* the extension and get its value back — how the
 * CLI asks "which artifact are you actually running?" (the extension fetches
 * its own dev stamp; see aiui-webext's dev-stamp module). Promises are awaited.
 */
export async function evaluateInExtension<T>(
  browserUrl: string,
  options: ExtensionContextOptions & { expression: string },
): Promise<EvaluateInExtensionResult<T>> {
  const context = await extensionContext(browserUrl, options);
  if (!context.ok) {
    return context;
  }
  const result = await evaluate(
    context.socket,
    options.expression,
    options.timeoutMs ?? 5000,
    true,
  );
  await context.release();
  if (result.threw) {
    return { ok: false, reason: "failed", detail: result.threw };
  }
  return { ok: true, value: result.value as T };
}

/** A live CDP socket into some context of the extension, plus how to let go. */
type ExtensionContext =
  | {
      ok: true;
      socket: WebSocket;
      via: "service-worker" | "page" | "wake-page";
      release: () => Promise<void>;
    }
  | ExtensionFailure;

async function extensionContext(
  browserUrl: string,
  options: ExtensionContextOptions,
): Promise<ExtensionContext> {
  const { extensionId, wakePage } = options;

  let targets: BrowserTarget[];
  try {
    targets = await listBrowserTargets(browserUrl);
  } catch (error) {
    return {
      ok: false,
      reason: "no-browser",
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  const own = extensionTargets(targets, extensionId).filter((t) => t.webSocketDebuggerUrl);
  const worker = own.find((t) => t.type === "service_worker");
  const page = own.find((t) => t.type === "page" || t.type === "other");
  const existing = worker ?? page;
  if (existing?.webSocketDebuggerUrl) {
    const socket = await connect(existing.webSocketDebuggerUrl);
    return socket
      ? {
          ok: true,
          socket,
          via: worker ? "service-worker" : "page",
          release: async () => close(socket),
        }
      : { ok: false, reason: "not-loaded" };
  }

  if (!wakePage) {
    return { ok: false, reason: "not-loaded" };
  }

  // No context to evaluate in (an idle MV3 worker leaves none): open one. A tab
  // at an extension URL only loads if the extension is installed — a failure
  // here IS "not loaded".
  const url = `chrome-extension://${extensionId}/${wakePage.replace(/^\/+/, "")}`;
  let opened: BrowserTarget;
  try {
    opened = await openTarget(browserUrl, url);
  } catch {
    return { ok: false, reason: "not-loaded" };
  }
  const ws =
    opened.webSocketDebuggerUrl ?? (await findTarget(browserUrl, opened.id))?.webSocketDebuggerUrl;
  const socket = ws ? await connect(ws) : undefined;
  if (!socket) {
    await closeTarget(browserUrl, opened.id);
    return { ok: false, reason: "not-loaded" };
  }
  return {
    ok: true,
    socket,
    via: "wake-page",
    release: async () => {
      close(socket);
      // Chrome tears extension pages down on reload, so this often 404s — the
      // tab is already gone. Best-effort either way.
      await closeTarget(browserUrl, opened.id);
    },
  };
}

/**
 * Evaluate an expression in a target. `expectReply: false` means the expression
 * is expected to kill its own context (`chrome.runtime.reload()`), so a closed
 * socket is the success signal, not an error.
 */
async function evaluate(
  socket: WebSocket,
  expression: string,
  timeoutMs: number,
  expectReply: boolean,
): Promise<{ value?: unknown; threw?: string }> {
  return await new Promise((resolve) => {
    const done = (result: { value?: unknown; threw?: string }) => {
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(
      () => done(expectReply ? { threw: `no reply within ${timeoutMs}ms` } : {}),
      timeoutMs,
    );
    socket.addEventListener("message", (event) => {
      let reply: {
        id?: number;
        error?: { message?: string };
        result?: {
          result?: { value?: unknown };
          exceptionDetails?: { exception?: { description?: string }; text?: string };
        };
      };
      try {
        reply = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (reply.id !== 1) {
        return; // an unrelated CDP event on the same socket
      }
      const ex = reply.result?.exceptionDetails;
      const threw = ex ? (ex.exception?.description ?? ex.text) : reply.error?.message;
      done(threw ? { threw } : { value: reply.result?.result?.value });
    });
    socket.addEventListener("close", () =>
      done(expectReply ? { threw: "the context closed before answering" } : {}),
    );
    socket.addEventListener("error", () => done({ threw: "the CDP socket errored" }));
    socket.send(
      JSON.stringify({
        id: 1,
        method: "Runtime.evaluate",
        params: { expression, awaitPromise: true, returnByValue: true },
      }),
    );
  });
}

function connect(url: string, timeoutMs = 3000): Promise<WebSocket | undefined> {
  return new Promise((resolve) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      close(socket);
      resolve(undefined);
    }, timeoutMs);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      resolve(undefined);
    });
  });
}

function close(socket: WebSocket): void {
  try {
    socket.close();
  } catch {}
}

/** `PUT /json/new?<url>` — the DevTools HTTP API's "open a tab". */
async function openTarget(browserUrl: string, url: string): Promise<BrowserTarget> {
  const res = await fetch(`${trim(browserUrl)}/json/new?${encodeURI(url)}`, {
    method: "PUT",
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    throw new Error(`the browser refused to open ${url} (${res.status} ${res.statusText})`);
  }
  return (await res.json()) as BrowserTarget;
}

async function findTarget(browserUrl: string, id: string): Promise<BrowserTarget | undefined> {
  try {
    return (await listBrowserTargets(browserUrl)).find((t) => t.id === id);
  } catch {
    return undefined;
  }
}

async function closeTarget(browserUrl: string, id: string): Promise<void> {
  try {
    await fetch(`${trim(browserUrl)}/json/close/${id}`, { signal: AbortSignal.timeout(3000) });
  } catch {}
}

function trim(browserUrl: string): string {
  return browserUrl.replace(/\/+$/, "");
}
