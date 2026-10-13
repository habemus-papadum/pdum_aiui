import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "test/browser",
  testMatch: "**/*.browser.ts",
  workers: 1,
  retries: 0,
  timeout: 30_000,
  use: { channel: "chromium", viewport: { width: 1280, height: 900 } },
  webServer: [
    {
      command: "pnpm -C ../../demos/circle exec vite --host 127.0.0.1 --port 5201 --strictPort",
      url: "http://127.0.0.1:5201",
      reuseExistingServer: false,
    },
    {
      command: "pnpm lab --host 127.0.0.1 --port 5202 --strictPort",
      url: "http://127.0.0.1:5202",
      reuseExistingServer: false,
    },
    {
      command: "pnpm -C ../../demos/gallery exec vite --host 127.0.0.1 --port 5203 --strictPort",
      url: "http://127.0.0.1:5203",
      reuseExistingServer: false,
    },
  ],
});
