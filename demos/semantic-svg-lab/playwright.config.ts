import { defineConfig } from "@playwright/test";

const port = Number(process.env.SVG_LAB_TEST_PORT ?? 5198);
export default defineConfig({
  testDir: "test/browser",
  testMatch: "**/*.browser.ts",
  outputDir: "../../node_modules/.cache/semantic-svg-browser",
  workers: 1,
  timeout: 30_000,
  use: { baseURL: `http://127.0.0.1:${port}`, viewport: { width: 1440, height: 1000 } },
  webServer: {
    command: `pnpm dev --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
  },
});
