import { defineConfig } from "vitest/config";

// Pure-math tests only (the engine is realm-free; the widgets are visually
// tested through the consuming demos). No aiui compiler pass needed: this
// package declares no cells/controls — it is playbook layer 1 plus imperative
// display islands.
export default defineConfig({
  test: {
    environment: "node",
    passWithNoTests: true,
  },
});
