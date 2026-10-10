import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const [tag, log] = process.argv.slice(2);
if (log) appendFileSync(log, `${tag}\n`);
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  const result =
    request.method === "initialize"
      ? {
          protocolVersion: request.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: tag, version: "1.0.0" },
        }
      : request.method === "tools/list"
        ? { tools: [] }
        : {};
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
});
