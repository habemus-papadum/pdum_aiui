import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Connection, endpoint, object, port, redactEndpoint, string } from "./model.ts";

/** A one-shot CDP connection; probes never create, select, resize or close a tab. */
export async function cdp(
  wsEndpoint: string,
  method: string,
  params = {},
  timeoutMs = 3000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsEndpoint);
    const timer = setTimeout(() => finish(new Error(`CDP ${method} timed out`)), timeoutMs);
    let done = false;
    const finish = (error?: Error, result: Record<string, unknown> = {}) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.close();
      if (error) reject(error);
      else resolve(result);
    };
    socket.addEventListener("open", () => socket.send(JSON.stringify({ id: 1, method, params })));
    socket.addEventListener("message", (event) => {
      try {
        const data = JSON.parse(String(event.data));
        if (data.id !== 1) return;
        if (data.error) finish(new Error(`CDP ${method}: ${data.error.message}`));
        else finish(undefined, object(data.result ?? {}, "CDP result"));
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.addEventListener("error", () =>
      finish(new Error(`Cannot connect to ${redactEndpoint(wsEndpoint)}`)),
    );
    socket.addEventListener("close", () => {
      if (method === "Browser.close") finish();
      else finish(new Error("CDP connection closed before replying"));
    });
  });
}

export async function probeEndpoint(input: string, timeoutMs = 3000): Promise<Connection> {
  const normalized = endpoint(input);
  const url = new URL(normalized);
  let wsEndpoint = normalized;
  if (url.protocol.startsWith("http")) {
    const response = await fetch(`${normalized}/json/version`, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
    if (!response.ok) throw new Error(`Debug endpoint returned HTTP ${response.status}`);
    const data = object(await response.json(), "Debug endpoint response");
    const ws = new URL(endpoint(string(data.webSocketDebuggerUrl, "webSocketDebuggerUrl")));
    if (!ws.protocol.startsWith("ws"))
      throw new Error("Debug endpoint did not return a WebSocket URL");
    // A forwarded HTTP endpoint may advertise an address on the browser host.
    // Keep the browser instance path, but connect via the authority the user selected.
    ws.host = url.host;
    ws.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    if (url.pathname !== "/" && !ws.pathname.startsWith(`${url.pathname.replace(/\/$/, "")}/`)) {
      ws.pathname = `${url.pathname.replace(/\/$/, "")}${ws.pathname}`;
    }
    wsEndpoint = ws.toString();
  }
  const result = await cdp(wsEndpoint, "Browser.getVersion", {}, timeoutMs);
  return {
    endpoint: normalized,
    wsEndpoint,
    browserVersion: string(result.product, "Browser product"),
  };
}

export async function autoConnection(dir: string): Promise<Connection> {
  const [rawPort, path] = (await readFile(join(dir, "DevToolsActivePort"), "utf8"))
    .trim()
    .split(/\r?\n/);
  if (!path?.startsWith("/devtools/browser/") || /[\s?#]/.test(path))
    throw new Error("Invalid DevToolsActivePort browser path");
  const connection = await probeEndpoint(`ws://127.0.0.1:${port(rawPort)}${path}`);
  return { ...connection, autoConnectDir: dir };
}
