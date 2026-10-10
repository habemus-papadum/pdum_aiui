import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "aibr",
    environment: "node",
    testTimeout: 20_000,
    // Separate fixture homes allocate fixed ports from the same host. Serialize files
    // so an unrelated fixture cannot claim a port between selection and browser start.
    // Explicit concurrent-launch tests still exercise locking within a shared home.
    fileParallelism: false,
  },
});
