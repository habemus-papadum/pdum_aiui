import { once } from "node:events";
import { createServer } from "node:http";
import { connect, createServer as createTcpServer } from "node:net";
import { expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { probeEndpoint } from "./cdp.ts";

it("connects through a forwarded port even when discovery advertises the browser host", async () => {
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        webSocketDebuggerUrl: "ws://browser-host.invalid:9222/devtools/browser/instance",
      }),
    );
  });
  const ws = new WebSocketServer({ server, path: "/devtools/browser/instance" });
  ws.on("connection", (socket) =>
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw));
      socket.send(JSON.stringify({ id: message.id, result: { product: "Chrome/forwarded" } }));
    }),
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No server address");
  const connections: import("node:net").Socket[] = [];
  const tunnel = createTcpServer((socket) => {
    const remote = connect(address.port, "127.0.0.1");
    connections.push(socket, remote);
    socket.pipe(remote).pipe(socket);
  });
  tunnel.listen(0, "127.0.0.1");
  await once(tunnel, "listening");
  try {
    const forwarded = tunnel.address();
    if (!forwarded || typeof forwarded === "string") throw new Error("No tunnel address");
    const result = await probeEndpoint(`http://127.0.0.1:${forwarded.port}`);
    expect(result.browserVersion).toBe("Chrome/forwarded");
    expect(new URL(result.wsEndpoint).port).toBe(String(forwarded.port));
  } finally {
    for (const socket of connections) socket.destroy();
    for (const client of ws.clients) client.terminate();
    tunnel.close();
    server.closeAllConnections();
    server.close();
  }
});

it("rejects an HTTP-only service without a usable CDP WebSocket", async () => {
  const server = createServer((_req, res) => res.end("{}"));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No address");
    await expect(probeEndpoint(`http://127.0.0.1:${address.port}`)).rejects.toThrow(
      "webSocketDebuggerUrl",
    );
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
