import { parseArgs } from "node:util";
import { startStack } from "./infrastructure/stack.mjs";

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "5173" },
    host: { type: "string", default: "0.0.0.0" },
  },
});
const port = Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid --port");
let stack;
let interrupted = false;
const startup = new AbortController();
const shutdown = async () => {
  interrupted = true;
  startup.abort();
  await stack?.stop();
};
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, shutdown);
try {
  stack = await startStack({
    port,
    host: values.host,
    signal: startup.signal,
    onFailure: (error) => {
      console.error(error);
      process.exitCode = 1;
    },
  });
  if (interrupted) await stack.stop();
  else {
    console.log(`\nDev instance: ${stack.instance}`);
    stack.server.printUrls();
    console.log("\nBrowser routes: /api/express, /api/python, /api/worker");
    for (const backend of stack.backends)
      console.log(`  ${backend.name}: ${backend.url} (internal)`);
    console.log("Stop this command to stop its backends.\n");
    stack.server.bindCLIShortcuts({
      print: true,
      customShortcuts: [
        {
          key: "q",
          description: "stop this stack",
          action: async () => {
            await shutdown();
          },
        },
      ],
    });
  }
} catch (error) {
  if (!interrupted) {
    console.error(error);
    process.exitCode = 1;
  }
}
