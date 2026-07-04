# Tab Identity: stamping "which tab am I?" onto dev pages

Technical reference for the extension's second job (besides the DevTools panel):
answering a question no web page can answer for itself — *which browser tab is this?* —
so the aiui intent tool can tell the agent which tab an intent came from. The consuming
half lives in the dev overlay's *Client Context* doc; the agent-facing routing workflow
is the `session-browser` skill.

## The mechanism

Everything happens in the background service worker (`src/background.ts`):

1. `chrome.tabs.onUpdated` fires with `status: "complete"` for a tab on a dev host
   (`http://localhost` / `http://127.0.0.1` — kept in sync with the manifest's
   `host_permissions`).
2. The worker already knows the tab's `chrome.tabs` identity from the event
   (`tabId`, `windowId`, `index`) — no page round-trip needed.
3. `chrome.debugger.getTargets()` maps the tab to its CDP page target:
   `TargetInfo.tabId === tab.id` for `type === "page"` gives the CDP `targetId`
   (`pageTargetIdFor` in `src/tab-info.ts`, the pure, unit-tested core). Crucially,
   `getTargets()` does **not attach** — attaching would disturb the Chrome DevTools MCP
   or any other debugger client sharing the browser. Callback style on purpose: the
   promise overloads are newer than the browsers this must run in.
4. `chrome.scripting.executeScript` injects a one-liner that writes the stamp as JSON to
   `document.documentElement.dataset.aiuiTab` (`data-aiui-tab` on `<html>`). The script
   runs in the isolated world, but the DOM is shared, so page code — the intent tool —
   can read it. Every navigation re-fires `onUpdated`, so the stamp tracks the tab.

The stamp (`TabStamp` in `src/tab-info.ts`):

```json
{ "chromeTabId": 1694699257, "windowId": 1694699241, "tabIndex": 0,
  "targetId": "CB992081B105C12732530E12D8B3B267" }
```

Every field is best-effort: no debugger access → no `targetId`; the overlay treats a
missing or malformed stamp as "no extension" and degrades to live url/title.

These ids are **correlation hints**, not handles: Chrome's extension tab id, the CDP
target id, and the Chrome DevTools MCP's `pageId` are three different namespaces, and
only `list_pages` produces the last one. The server-side prompt augmentation says so to
the agent explicitly. Background: `archive/chrome-devtools-mcp-tab-routing-notes.md`.

## Why injection from the background, not a manifest content script

The first implementation was a `content_scripts` entry messaging the background for its
ids. It failed for a reason worth remembering: **content scripts are classic scripts,
but this package compiles as ES modules** (`"type": "module"` + NodeNext), so tsc
appends `export {}` to any import-free file — a fatal `SyntaxError` in a classic script,
and one that surfaces nowhere unless the profile has Developer Mode on. Injecting from
the background sidesteps the emit problem entirely and is also simply better: the worker
already knows the `tabId`, so the message round-trip disappears.

## Permissions and debugging notes

- Requires `debugger` (for `getTargets`) and `scripting` (for the injection), plus the
  localhost `host_permissions`. The `debugger` permission is why the stamp exists at
  all; it never attaches.
- **Permission escalation disables the extension.** Reloading an unpacked build whose
  manifest gained a permission leaves it disabled until re-enabled (toggle in
  `chrome://extensions`). A fresh browser start loads it cleanly.
- **Extension errors are invisible without Developer Mode.** Chrome collects extension
  runtime/manifest errors only when the profile's Developer Mode is on — flip it on in
  `chrome://extensions` before trusting an "it loads fine".
- The stamp lands only on tabs (re)loaded while the extension is active; tabs loaded
  before it won't have one until their next navigation.
