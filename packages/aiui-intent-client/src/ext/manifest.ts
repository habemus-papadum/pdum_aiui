/**
 * manifest.ts — the MV3 manifest, as data. The build script writes it to
 * `dist-ext/manifest.json`; nothing generates it at runtime.
 *
 * No CRXJS: this is a plain static build (see scripts/build-ext.ts). The old
 * extension's dev loader bought hot reloading and cost a whole toolchain, and
 * the client no longer needs it — the panel's hot-iteration surface is the
 * PLAIN PAGE the channel serves, which is a normal Vite dev server. The
 * extension is a release shell, built and loaded unpacked.
 */

/** A NEW identity — deliberately not the frozen extension's key.
 *
 * Same key = same id = Chrome treats the new extension as an UPDATE of the old
 * one, which would silently retire the safety net we are keeping. This is a
 * fresh RSA public key (a public key is not a secret; there is no private-key
 * use for an unpacked extension), and it pins the id to
 * `cdpbfpcelmifhagikjlfpgfipggcmdeg` on every machine — which is what a native
 * messaging allowlist would need, should the cold-start discovery ever want it.
 */
const PUBLIC_KEY =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAvReP4eb7pCQN2IITLwGCLuaosF60fhoFqkZGI9gFVRSTSu+K++9UYKoCRCItUb1JmGXATtVx8wXTGDatFf8wY96zhKjIn4xVYzrSJPylbXNUJit0mjtTG3oT5lL5r2GhNBnYfcL+XSzF/NsW2hQcRh06PJkgQTU/To3wHT69PJHrjiMXzg86m7gSUm1D9FiTMrHSswTfjWUeqnu+gNNq48ArF6Q30J2MosB1RIkf5VcnipnFo5zQGIaMFd2dmn+bcFzgMttV6b7kaW3TRRxdv8WJqe2THfkKNghhVnK9LQYQFjIn4p7u1oXVK7FD5cIymb9jM+ZBLzS53xEnKcbeywIDAQAB";

/** The id Chrome derives from {@link PUBLIC_KEY} (sha256 → a–p alphabet). */
export const EXTENSION_ID = "cdpbfpcelmifhagikjlfpgfipggcmdeg";

export const manifest = {
  manifest_version: 3,
  name: "aiui intent client",
  version: "0.1.0",
  description:
    "The aiui intent client: a side panel that drives the page — ink, keys, capture, dictation — into a live Claude Code session.",
  key: PUBLIC_KEY,
  action: {
    default_title: "aiui: invoke this tab / open the panel",
  },
  // The activation gesture. A `chrome.commands` press is ALSO an extension
  // INVOCATION, which is what grants the tab `tabCapture` standing — so this
  // chord is not merely a shortcut, it is how the capture grant comes to exist
  // (BEHAVIOR.md). Chrome refuses a suggestion already taken by another
  // extension, in which case the command starts unbound and the user binds it
  // at chrome://extensions/shortcuts — which is exactly what happens if the
  // FROZEN extension is also loaded, since it claims the same chord.
  commands: {
    "aiui-intent-activate": {
      suggested_key: { default: "Ctrl+B", mac: "Command+B" },
      description: "aiui: arm and open a turn on this tab",
    },
  },
  background: {
    service_worker: "sw.js",
    type: "module",
  },
  side_panel: {
    default_path: "index.html",
  },
  // "tabs": targeting (the active tab, its url/title for the turn's preamble).
  // "tabCapture": the shot path — the worker mints an invocation-gated stream
  //   id and the PANEL consumes it (measured, M10; see ext/capture.ts).
  // "scripting": re-inject content scripts after an extension reload, which
  //   orphans the copies in open tabs (ring/ink/keys die silently otherwise).
  // "webNavigation": SPA route changes — an isolated-world content script
  //   cannot see the page's own `history` calls, so the browser tells us.
  // "nativeMessaging": OPTIONAL cold-start channel discovery (ext/channel.ts);
  //   absent a host, port probing carries us.
  permissions: [
    "sidePanel",
    "storage",
    "tabs",
    "tabCapture",
    "scripting",
    "webNavigation",
    "nativeMessaging",
  ],
  // <all_urls>: the content scripts' reach, and `executeScript`'s (a declared
  // content_scripts match does not grant host access for injection).
  // Loopback: the panel fetches /health and the channel registry over HTTP.
  host_permissions: ["<all_urls>", "http://127.0.0.1/*", "http://localhost/*"],
  content_scripts: [
    {
      matches: ["<all_urls>"],
      js: ["content.js"],
      run_at: "document_idle",
    },
    {
      // The MAIN world, for the one fact that only lives there: whether the
      // page is aiui-instrumented (`window.__AIUI__`). Five lines; see
      // ext/content-main.ts.
      matches: ["<all_urls>"],
      js: ["content-main.js"],
      run_at: "document_idle",
      world: "MAIN" as const,
    },
  ],
} as const;
