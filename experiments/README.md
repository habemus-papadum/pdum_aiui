# Experiments

Self-contained spikes, outside the published pnpm workspace and release pipeline.

[Architecture review](./architecture-review.md): findings, corrected integration
bugs, reusable boundaries, and what the Mac packaging checks actually prove.

- [Dev stack](./dev-stack/README.md): one Vite frontend with Express, Python, and
  Workers backends; isolated concurrent instances; Cloudflare assets/R2 gateways.
- [Electron stack](./electron-stack/README.md): the same browser API model in a
  web-style desktop package and a desktop-specific app, with independent bundled
  runtimes, concurrent source-first development, and direct-download packaging.
- [macOS notarization](./macos-notarization/README.md): Developer ID signing of the
  Electron app and bundled runtimes, reusable Keychain credentials, and resumable
  DMG submission/stapling with artifact receipts.
  [Apple development cheat sheet](../docs/macOS-noterization-cheat-sheet/README.md).
