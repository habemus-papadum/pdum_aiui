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

/** A NEW identity — deliberately not the retired frozen extension's key (out
 * of the tree, but still installed in some profiles as a safety net).
 *
 * Same key = same id = Chrome treats the new extension as an UPDATE of the old
 * one, which would silently retire that safety net. This is a
 * fresh RSA public key (a public key is not a secret; there is no private-key
 * use for an unpacked extension), and it pins the id to
 * `cdpbfpcelmifhagikjlfpgfipggcmdeg` on every machine — which is what a native
 * messaging allowlist would need, should the cold-start discovery ever want it.
 */
const PUBLIC_KEY =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAvReP4eb7pCQN2IITLwGCLuaosF60fhoFqkZGI9gFVRSTSu+K++9UYKoCRCItUb1JmGXATtVx8wXTGDatFf8wY96zhKjIn4xVYzrSJPylbXNUJit0mjtTG3oT5lL5r2GhNBnYfcL+XSzF/NsW2hQcRh06PJkgQTU/To3wHT69PJHrjiMXzg86m7gSUm1D9FiTMrHSswTfjWUeqnu+gNNq48ArF6Q30J2MosB1RIkf5VcnipnFo5zQGIaMFd2dmn+bcFzgMttV6b7kaW3TRRxdv8WJqe2THfkKNghhVnK9LQYQFjIn4p7u1oXVK7FD5cIymb9jM+ZBLzS53xEnKcbeywIDAQAB";

/** The id Chrome derives from {@link PUBLIC_KEY} (sha256 → a–p alphabet). */
export const EXTENSION_ID = "cdpbfpcelmifhagikjlfpgfipggcmdeg";

/**
 * The `chrome.storage.local` key PREFIX for the CDP driver roster (owner,
 * 2026-07-19; superseding the single `aiui2.cdpChannel` slot, whose
 * last-writer-wins shape made two channels sharing one browser FLAP the tag).
 * Each channel's tagger (src/cdp/tagger.ts) writes ONLY its own entry —
 * `aiui2.cdpDriver:<port>` → `{port, browserUrl, taggedAt}` — so co-driving
 * channels never collide, and the set of fresh entries IS "who drives this
 * browser", plural (multi-agent co-driving is a supported workflow). Both
 * halves of the contract import from here: the tagger composes the write,
 * the extension's discovery + alignment read the roster. A write arrives
 * through the browser's own debug endpoint, so its presence is same-browser
 * PROOF, not just a hint.
 */
export const CDP_DRIVER_TAG_PREFIX = "aiui2.cdpDriver:";

/**
 * How stale a roster entry may be before readers drop it. The tagger
 * reaffirms every 60s (cdp/tagger.ts REAFFIRM_MS); 3 beats + slack tolerates
 * a slow beat while aging out entries from crashed channels (a clean stop
 * removes its entry; a crash cannot). Readers ALSO liveness-probe `/health`,
 * so this is the belt, not the verdict.
 */
export const CDP_DRIVER_TAG_FRESH_MS = 200_000;

export const manifest = {
  manifest_version: 3,
  name: "aiui intent client",
  // Stamped by scripts/versioning.mjs with the workspace's semver CORE (Chrome
  // rejects the `+dev` suffix the package.jsons carry). Don't hand-edit it —
  // `pnpm version:check` fails if it drifts from lockstep.
  version: "0.8.1",
  description:
    "The aiui intent client: a side panel that drives the page — ink, keys, capture, dictation — into a live Claude Code session.",
  key: PUBLIC_KEY,
  // The aiui favicon (derived from avatar.png at build setup time via sips;
  // sources live in src/ext/icons/, copied to dist-ext/icons by build-ext.ts).
  icons: {
    16: "icons/icon16.png",
    32: "icons/icon32.png",
    48: "icons/icon48.png",
    128: "icons/icon128.png",
  },
  action: {
    default_title: "aiui: invoke this tab / open the panel",
    default_icon: {
      16: "icons/icon16.png",
      32: "icons/icon32.png",
    },
  },
  // NOTE deliberately NO `commands` block (owner, 2026-07-20). The activation
  // chord (Command/Ctrl+Period) is retired: arming rides the channel-connected
  // edge now, and the capture grant's invocation gestures are the toolbar
  // click and the context-menu item (sw.ts) — both real invocations, which is
  // what `tabCapture` standing requires (BEHAVIOR.md).
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
  //   orphans the copies in open tabs (ring/pencil/keys die silently otherwise).
  // "webNavigation": SPA route changes — an isolated-world content script
  //   cannot see the page's own `history` calls, so the browser tells us.
  // "nativeMessaging": OPTIONAL cold-start channel discovery (ext/channel.ts);
  //   absent a host, port probing carries us.
  // "contextMenus": the right-click grant item — an extension INVOCATION that
  //   works even with the toolbar icon unpinned (sw.ts, GRANT_MENU_ID).
  permissions: [
    "sidePanel",
    "storage",
    "tabs",
    "tabCapture",
    "scripting",
    "webNavigation",
    "nativeMessaging",
    "contextMenus",
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
      // The MAIN world, for what only lives there: the aiui-instrumented
      // fact (`window.__AIUI__`), the tools bridge, and jump-to-editor's
      // arm; see ext/content-main.ts.
      matches: ["<all_urls>"],
      js: ["content-main.js"],
      run_at: "document_idle",
      world: "MAIN" as const,
    },
  ],
} as const;
