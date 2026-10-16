import { defineConfig } from "@playwright/test";

const port = Number(process.env.PENCIL_TEST_PORT_BASE ?? 5201);

export default defineConfig({
  testDir: "test/browser",
  testMatch: "**/*.browser.ts",
  workers: 1,
  retries: 0,
  timeout: 30_000,
  use: { channel: "chromium", viewport: { width: 1280, height: 900 } },
  webServer: [
    {
      command: `pnpm -C ../../demos/circle exec vite --host 127.0.0.1 --port ${port} --strictPort`,
      url: `http://127.0.0.1:${port}`,
      reuseExistingServer: false,
    },
    {
      command: `pnpm lab --host 127.0.0.1 --port ${port + 1} --strictPort`,
      url: `http://127.0.0.1:${port + 1}`,
      reuseExistingServer: false,
    },
    {
      command: `pnpm -C ../../demos/gallery exec vite --host 127.0.0.1 --port ${port + 2} --strictPort`,
      url: `http://127.0.0.1:${port + 2}`,
      reuseExistingServer: false,
    },
  ],
});
