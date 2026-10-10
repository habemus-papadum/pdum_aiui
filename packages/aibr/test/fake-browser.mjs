// A separate browser-shaped process for lifecycle tests; no real user profile.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { hostname } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";

const option = (key) => process.argv.find((v) => v.startsWith(`${key}=`))?.slice(key.length + 1);
const dir = option("--user-data-dir");
const port = Number(option("--remote-debugging-port"));
mkdirSync(dir, { recursive: true });
if (existsSync(join(dir, "SingletonLock"))) process.exit(0);
symlinkSync(`${hostname()}-${process.pid}`, join(dir, "SingletonLock"));
const id = randomUUID();
const path = `/devtools/browser/${id}`;
let endpoint;
const server = createServer((req, res) => {
  if (req.url !== "/json/version") {
    res.writeHead(404).end();
    return;
  }
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ Browser: "Chrome/test", webSocketDebuggerUrl: endpoint }));
});
const sockets = new WebSocketServer({ server, path });
sockets.on("connection", (socket) =>
  socket.on("message", (data) => {
    const request = JSON.parse(String(data));
    const result =
      request.method === "Browser.getVersion"
        ? { product: "Chrome/test" }
        : { targetId: "new-tab" };
    socket.send(JSON.stringify({ id: request.id, result }));
    if (request.method === "Browser.close") setTimeout(close, 30);
  }),
);
function close() {
  rmSync(join(dir, "SingletonLock"), { force: true });
  for (const client of sockets.clients) client.terminate();
  server.close(() => process.exit(0));
}
process.on("SIGTERM", close);
process.on("SIGINT", close);
server.listen(port, "127.0.0.1", () => {
  const actualPort = server.address().port;
  endpoint = `ws://127.0.0.1:${actualPort}${path}`;
  if (port === 0) writeFileSync(join(dir, "DevToolsActivePort"), `${actualPort}\n${path}\n`);
  process.stderr.write(`DevTools listening on ${endpoint}\n`);
});
