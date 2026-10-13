---
name: source-first-workspaces
description: Set up or migrate a TypeScript workspace so apps consume sibling packages directly from source and Vite picks up edits without package rebuilds. Use for source-first or editable monorepo dependencies, cross-package hot updates, and keeping compiled npm artifacts alongside that development workflow. Covers pnpm/Vite and the custom export-condition alternative; does not require AIUI.
---

# Source-first workspaces

Read the [source-first workspace guide](../../packages/aiui-build-config/docs/source-first-workspaces.md)
before changing the target repository. It is the maintained recipe: package linking and
exports, Vite transforms, publishing, migration pitfalls, and checks for both live source
and installed artifacts.

Resolve that guide relative to this skill's directory, including when running from an
installed plugin cache. Apply the recipe to the user's target repository; the plugin's
checkout supplies reference material.

Use the guide's pnpm recipe when it fits the target. For a repository using another package
manager or an established export-condition setup, use its alternatives section and preserve
the existing toolchain. Choose only the setup and validation needed for the requested scope.

Report which imports now resolve to source, what validation actually ran, and any remaining
build requirements. Distinguish automatic browser updates from preserving application state
through HMR, and distinguish successful local development from validated published artifacts.
