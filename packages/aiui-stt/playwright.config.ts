import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "test/browser",
  workers: 1,
  retries: 0,
  timeout: 30_000,
  use: {
    baseURL: "http://127.0.0.1:5194",
    // Live runs carry single-use credentials in socket URLs; never save traces.
    trace: "off",
    video: "off",
    launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] },
  },
  projects: [{ name: "offline", testMatch: "**/*.browser.ts" }],
  webServer: {
    command: "pnpm exec vite --host 127.0.0.1 --port 5194 --strictPort",
    url: "http://127.0.0.1:5194/test/browser/",
    reuseExistingServer: false,
  },
});
