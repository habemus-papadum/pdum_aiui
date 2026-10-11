import { defineConfig } from "@playwright/test";
import offline from "./playwright.config";

// A separate config makes even a bare `playwright test` offline by default.
export default defineConfig({
  ...offline,
  projects: [{ name: "live", testMatch: "**/*.live.ts" }],
});
