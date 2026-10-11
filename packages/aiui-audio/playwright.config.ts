import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "test/browser",
  testMatch: "**/*.browser.ts",
  use: {
    baseURL: "http://127.0.0.1:5192",
    launchOptions: {
      args: [
        "--autoplay-policy=no-user-gesture-required",
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
      ],
    },
  },
  webServer: {
    command: "pnpm exec vite --host 127.0.0.1 --port 5192 --strictPort",
    url: "http://127.0.0.1:5192/test/browser/",
    reuseExistingServer: false,
  },
});
