/**
 * Installing an unpacked extension into the session browser over raw CDP.
 *
 * Chrome installs an unpacked extension **by path**, so a browser that was
 * launched against one directory would otherwise ignore a rebuilt artifact
 * elsewhere forever — only a trip to chrome://extensions could fix it. With
 * this, the CLI just points the running browser at the right directory. The
 * extension id is unchanged (it comes from the manifest key, not the path),
 * so nothing that depends on the id needs to know this happened.
 */

/**
 * Install (or re-point) an unpacked extension in a running browser — CDP's
 * `Extensions.loadUnpacked`, i.e. "Load unpacked" without the human.
 *
 * Best-effort by design: the domain is recent (Chrome ≥ 129, measured working on
 * Chrome for Testing 150) and a browser may refuse. Callers fall back to telling
 * the human what to click.
 */
export async function loadUnpackedExtension(
  browserUrl: string,
  path: string,
): Promise<{ ok: true; extensionId: string } | { ok: false; detail: string }> {
  let endpoint: string;
  try {
    const version = (await (
      await fetch(`${trim(browserUrl)}/json/version`, { signal: AbortSignal.timeout(3000) })
    ).json()) as { webSocketDebuggerUrl?: string };
    if (!version.webSocketDebuggerUrl) {
      return { ok: false, detail: "the browser exposes no debugger endpoint" };
    }
    endpoint = version.webSocketDebuggerUrl;
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }

  const socket = await connect(endpoint);
  if (!socket) {
    return { ok: false, detail: "couldn't open a CDP socket to the browser" };
  }
  try {
    const reply = await request(socket, "Extensions.loadUnpacked", { path });
    if (reply.error) {
      return { ok: false, detail: reply.error };
    }
    const id = (reply.result as { id?: string } | undefined)?.id;
    return id
      ? { ok: true, extensionId: id }
      : { ok: false, detail: "the browser accepted the load but named no extension" };
  } finally {
    close(socket);
  }
}

/** One CDP request/response on an open socket. */
function request(
  socket: WebSocket,
  method: string,
  params: unknown,
  timeoutMs = 10_000,
): Promise<{ result?: unknown; error?: string }> {
  return new Promise((resolve) => {
    const id = 1;
    const timer = setTimeout(() => resolve({ error: `no reply to ${method}` }), timeoutMs);
    const onMessage = (event: MessageEvent) => {
      let reply: { id?: number; result?: unknown; error?: { message?: string } };
      try {
        reply = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (reply.id !== id) {
        return;
      }
      clearTimeout(timer);
      socket.removeEventListener("message", onMessage);
      resolve(reply.error ? { error: reply.error.message ?? method } : { result: reply.result });
    };
    socket.addEventListener("message", onMessage);
    socket.send(JSON.stringify({ id, method, params }));
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

function trim(browserUrl: string): string {
  return browserUrl.replace(/\/+$/, "");
}
