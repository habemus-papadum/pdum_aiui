import { reportReady } from "../../infrastructure/ready.mjs";
import { createApp } from "./app.mjs";

// Standalone entry point for a hosted service; also supports the dev-ready convention.
const server = createApp(process.env.DEV_INSTANCE_ID).listen(
  Number(process.env.PORT ?? 0),
  process.env.HOST ?? "127.0.0.1",
  () => reportReady(`http://127.0.0.1:${server.address().port}/`),
);
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
