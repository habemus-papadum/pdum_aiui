import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "test/browser",
  testMatch: "**/*.browser.ts",
  workers: 1,
  retries: 0,
  timeout: 30_000,
  use: {
    baseURL: "http://127.0.0.1:5195",
    // Full Chromium in headless mode supports native tab capture; headless-shell does not.
    channel: "chromium",
    viewport: { width: 1280, height: 900 },
    launchOptions: {
      args: [
        "--auto-accept-this-tab-capture",
        "--auto-select-tab-capture-source-by-title=Screen capture browser tests",
        "--autoplay-policy=no-user-gesture-required",
      ],
    },
  },
  webServer: [
    {
      command: "pnpm exec vite --host 127.0.0.1 --port 5195 --strictPort",
      url: "http://127.0.0.1:5195/test/browser/",
      reuseExistingServer: false,
    },
    {
      command:
        "pnpm -C ../../demos/screen-capture exec vite --host 127.0.0.1 --port 5196 --strictPort",
      url: "http://127.0.0.1:5196",
      reuseExistingServer: false,
    },
  ],
});
