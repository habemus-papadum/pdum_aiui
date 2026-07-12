import { defineManifest } from "@habemus-papadum/aiui-webext/vite";

/**
 * The extension manifest. Chrome needs plain dotted integers here, so this
 * version is deliberately independent of the workspace lockstep version (same
 * stance as aiui-devtools-extension).
 *
 * Permissions are added per plan step, not hoarded: step 1 needs only the side
 * panel and storage (an unpacked extension re-prompts nothing, but permission
 * discipline keeps the eventual store surface honest).
 */
export default defineManifest({
  manifest_version: 3,
  name: "aiui intent tool (dev)",
  version: "0.1.0",
  // Pins the unpacked extension id to ngakidpkjdgaajnlpggbchpaikilkpmp on
  // every machine (the id is a hash of this public key, not of the install
  // path). The native-messaging manifest's allowed_origins depends on it —
  // see `aiui extension install-native-host` (DEFAULT_EXTENSION_ID must match).
  // A public key is not a secret; there is no private-key use for unpacked
  // extensions.
  key: "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAmmVUHMCRZqnhN3WEhaOEYl99LXfEhRqEcbHVJ5HWhQBtn/Ug5ZlL1B5kxvZzlAnvMjUhOjarJ/wI00NUu9MitiXsCwGqRoNRkncn4/UvWrXCZzvv2O8fYdSXz0IgHN5sz1Zi1w2B6WrqXDo0ewvVUxShQk/obQDWogdfMUEdd6AD2rFA+48bWoHAlft2kT4x6Io4lQBRAGVV444AzoMhZHYrbxATmlX7XLwqgOKSvtvJoYPiHIcHGzG0mnVZARpqe7u+0nxQhT/mg7cGoXp9QALLcLFgA3imhLq77IwfT9yVdN9V8n2fuhbWlvW2q4m8TcF+kurYbcMefeWpCNRahQIDAQAB",
  description:
    "aiui web intent tool as a browser extension — per-window side panel, channel binding, capture, ink, page tools.",
  // The aiui favicon (derived from demos/gallery/public/favicon.png at build
  // setup time via sips; sources live in public/icons/, copied by Vite).
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
  // The leader (proposal §13.5): one global shortcut opens the modal key
  // layer (then i/s/a/d/esc — see src/panel/leader.ts). A chrome.commands
  // press is ALSO an extension invocation, so it grants the tab the same
  // activeTab/tabCapture standing as a toolbar click — the softener for the
  // invocation gate (CONTINUITY trap 4). Users rebind it at
  // chrome://extensions/shortcuts; if Chrome refuses the suggestion (already
  // taken), the command simply starts unbound there.
  commands: {
    "aiui-leader": {
      suggested_key: { default: "Ctrl+B", mac: "Command+B" },
      description: "aiui: open the key layer (leader)",
    },
  },
  background: {
    service_worker: "src/sw.ts",
    type: "module",
  },
  side_panel: {
    default_path: "src/panel/index.html",
  },
  // "tabs": the turn hello carries the active tab's url/title (context for
  // the lowered prompt's preamble); without it query() returns bare tabs.
  // "tabCapture": the shot path — the SW mints an invocation-gated stream id
  // and the PANEL consumes it with getUserMedia (measured, RESULTS.md M10).
  // No "offscreen": a side panel can hold the stream itself, so the offscreen
  // capture room (and its base64 round-trip) is gone.
  // "scripting": re-inject the content script into open tabs after an
  // extension reload (sw.ts) — a reload orphans the injected copies and only
  // navigation would restore them (ring/ink/keys died in every open tab).
  permissions: ["sidePanel", "storage", "nativeMessaging", "tabs", "tabCapture", "scripting"],
  // <all_urls>: executeScript needs host access per-origin — the declared
  // content_scripts match doesn't grant it. Same reach the content script
  // already has, now usable for re-injection. Loopback entries: the panel
  // probes /health and /debug/api/channels over fetch (CORS-gated without).
  host_permissions: ["<all_urls>", "http://127.0.0.1/*", "http://localhost/*"],
  content_scripts: [
    {
      matches: ["<all_urls>"],
      js: ["src/content.ts"],
      run_at: "document_idle",
    },
  ],
});
