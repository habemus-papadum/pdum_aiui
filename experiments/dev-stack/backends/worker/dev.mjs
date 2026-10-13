import { fileURLToPath } from "node:url";
import { cloudflare } from "@cloudflare/vite-plugin";
import { createServer } from "vite";
import { reportReady } from "../../infrastructure/ready.mjs";

// Official Workers runtime integration, in a child so global tooling state is isolated.
const server = await createServer({
  configFile: false,
  root: fileURLToPath(new URL(".", import.meta.url)),
  cacheDir: `${process.env.DEV_STATE_DIR}/vite-worker`,
  plugins: [
    cloudflare({
      configPath: fileURLToPath(new URL("wrangler.jsonc", import.meta.url)),
      config: {
        name: `dev-stack-backend-${process.env.DEV_INSTANCE_ID}`,
        vars: { INSTANCE_ID: process.env.DEV_INSTANCE_ID },
      },
      persistState: { path: `${process.env.DEV_STATE_DIR}/worker` },
      inspectorPort: false,
      remoteBindings: false,
    }),
  ],
  server: { host: "127.0.0.1", port: 0, strictPort: true },
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    await server.close();
    process.exit(0);
  });
}
await server.listen();
reportReady(`http://127.0.0.1:${server.httpServer.address().port}/`);
