# Chrome DevTools MCP: identifying and routing an agent to a specific browser tab

_Last checked: 2026-07-04_

## Executive summary

There is not one universal “tab ID” that works across every layer involved here. There are at least three related identifiers:

| Layer | Identifier | Shape | Who consumes it | Notes |
|---|---:|---|---|---|
| Chrome extension Tabs API | `chrome.tabs.Tab.id` | number | Chrome extension APIs | Unique within a browser session. Useful for identifying the tab the user is visually looking at. Not directly accepted by Chrome DevTools MCP `select_page`. |
| Chrome extension Debugger API | `chrome.debugger.TargetInfo.id` / debug `targetId` | string | `chrome.debugger` and raw CDP-style tooling | Can be correlated with `tabId` for page targets because `TargetInfo` includes both `id` and `tabId`. Useful if the downstream agent has raw Chrome DevTools Protocol access. |
| Chrome DevTools Protocol Target domain | `Target.TargetID` / `targetInfo.targetId` | string | Raw CDP client | Used with CDP commands like `Target.getTargets`, `Target.attachToTarget`, and `Target.activateTarget`. |
| Chrome DevTools MCP server | `pageId` | number | MCP tools such as `select_page` | MCP-level page handle returned by `list_pages`. Treat this as the authoritative ID for MCP tool calls. It should not be assumed to equal Chrome’s numeric tab ID or CDP’s target ID. |

For an MCP-only agent, the preferred workflow is:

1. Use a small browser-side mechanism, such as an extension, to gather identifying metadata for the currently intended tab.
2. Pass that metadata to the agent through your existing handoff channel.
3. Have the agent call Chrome DevTools MCP `list_pages`.
4. Have the agent match the intended tab by URL, title, and possibly a marker value.
5. Have the agent call `select_page({ pageId })` with the `pageId` returned by MCP.

For a raw-CDP-capable agent, the extension can additionally provide the CDP/debug `targetId`. The agent can then use CDP’s `Target.getTargets` / `Target.attachToTarget` path directly.

## What the current docs say

The Chrome DevTools MCP server can connect to an already-running Chrome instance through a debug-port-style browser URL, commonly `http://127.0.0.1:9222`, via the `--browser-url` option. The same docs warn that enabling a remote debugging port lets local applications control that browser instance, and recommend using a separate user data directory rather than exposing a normal browsing profile.

The MCP tool reference includes a `list_pages` tool whose description is “Get a list of pages open in the browser.” It also includes `select_page`, whose required parameter is `pageId`, described as “The ID of the page to select,” with the instruction to call `list_pages` to get available pages.

The server also has an `--experimentalPageIdRouting` option. The docs describe it as exposing `pageId` on page-scoped tools so concurrent agents or subagents can route calls to the tab they are working with. That matters if a single MCP server is shared by multiple agents.

The June 18, 2026 v1.3.0 release notes say that `list_pages` output includes page title. That is useful because title-plus-URL is much easier to correlate with the user’s visible tab than URL alone.

## What a simple extension can learn

A Chrome extension can learn two useful classes of information.

First, it can identify the user’s current tab with `chrome.tabs.query({ active: true, lastFocusedWindow: true })`. The Tabs API documentation describes this pattern as retrieving the active tab from the focused or most recently focused window. A `tabs.Tab` can include `id`, `windowId`, `index`, `title`, and `url`; access to sensitive fields such as `url` and `title` generally requires the `tabs` permission, host permissions, or `activeTab` depending on how the extension is designed.

Second, if the extension has the `debugger` permission, it can call `chrome.debugger.getTargets()`. The Debugger API documentation says this returns the available debug targets. For page targets, `TargetInfo` includes:

- `id`: the debug target ID;
- `tabId`: the Chrome tab ID, defined when `type == "page"`;
- `title`;
- `url`;
- `type`;
- `attached`.

That gives a direct extension-side mapping:

```text
current visual tab -> chrome.tabs.Tab.id -> chrome.debugger.TargetInfo where TargetInfo.tabId === Tab.id -> debug target ID
```

The extension does not need to attach to the page just to collect this mapping. In fact, avoiding an attach is preferable because attachment can interfere with other debugging clients.

## Suggested handoff payload

Since you said there is another mechanism to get information to the agent, I would treat the extension or browser-side helper as producing a small structured payload like this:

```json
{
  "kind": "chrome-devtools-tab-handoff",
  "observedAt": "2026-07-04T22:30:00Z",
  "chromeTab": {
    "tabId": 123456789,
    "windowId": 987654321,
    "index": 4,
    "active": true,
    "title": "My App - Checkout",
    "url": "http://localhost:3000/checkout"
  },
  "debugTarget": {
    "targetId": "A1B2C3D4E5F6...",
    "type": "page",
    "attached": false,
    "title": "My App - Checkout",
    "url": "http://localhost:3000/checkout"
  },
  "agentInstruction": {
    "preferredPath": "Use Chrome DevTools MCP list_pages, find the matching page, then call select_page with MCP's pageId.",
    "rawCdpFallback": "If raw CDP access is available, use debugTarget.targetId with the Target domain."
  }
}
```

For MCP use, the most important fields are usually:

```json
{
  "title": "My App - Checkout",
  "url": "http://localhost:3000/checkout",
  "debugTargetId": "A1B2C3D4E5F6..."
}
```

The `debugTargetId` is useful context, but the agent should not assume that MCP’s `select_page` accepts it. MCP wants the MCP `pageId` from `list_pages`.

## Agent-side matching strategy

A robust MCP-only instruction would be:

```text
Use the Chrome DevTools MCP server connected to the running browser.
Call list_pages.
Find the page whose URL and title match this handoff payload:
- URL: http://localhost:3000/checkout
- Title: My App - Checkout
If more than one page matches, prefer the one whose title, URL, and current visible state most closely match.
Then call select_page with the pageId returned by list_pages.
After selecting the page, verify by evaluating document.location.href and document.title.
```

This is intentionally phrased in terms of MCP’s own `pageId`, not Chrome’s extension `tabId`.

## Handling ambiguous tabs

URL/title matching is usually enough for local development, but it fails when multiple tabs show the same app route. In that case, add a marker.

Possible marker approaches:

1. Add a temporary query parameter or hash fragment to the target tab’s URL, such as `?agentTabMarker=<uuid>` or `#agentTabMarker=<uuid>`, if changing the URL is safe for the app.
2. Have the extension inject a page-global marker, such as `window.__AGENT_TAB_MARKER = "<uuid>"`, if your extension has the right host/scripting permissions.
3. Have the extension set a visible but harmless page marker, such as a data attribute on `document.documentElement`, if that will not disturb the app.

Then the agent can use MCP to check candidate pages:

```text
For each likely page from list_pages, select it temporarily and evaluate:
() => ({
  href: location.href,
  title: document.title,
  marker: window.__AGENT_TAB_MARKER || document.documentElement.dataset.agentTabMarker || null
})

Choose the page whose marker equals the handoff marker.
```

This is more reliable than title/URL matching when there are duplicate tabs.

## Raw CDP path

If the agent can talk directly to the browser-level Chrome DevTools Protocol, it can use the CDP target ID rather than the MCP `pageId`.

The CDP Target domain supports target discovery and attaching to targets. The relevant conceptual flow is:

```text
Target.getTargets
  -> returns targetInfos, including targetId, type, title, url, attached, etc.

Find the targetInfo whose targetId matches the handoff payload.

Target.attachToTarget({ targetId, flatten: true })
  -> returns a sessionId

Send future page-scoped CDP commands with that sessionId.
```

This path is different from the MCP path. It is useful if the agent or infrastructure has raw CDP access. If the agent only has the official Chrome DevTools MCP tools, use `list_pages` and `select_page` instead.

## Practical recommendation

For your use case, I would build the browser-side helper around this contract:

- Always include `url`, `title`, `chromeTabId`, `windowId`, and `index`.
- Include `debugTargetId` when `chrome.debugger.getTargets()` can map the active tab to a page target.
- Include a marker if duplicate tabs are likely.
- Tell the MCP agent explicitly that `chromeTabId` and `debugTargetId` are correlation hints, while MCP `pageId` must come from `list_pages`.
- After `select_page`, have the agent verify the chosen page with `document.title`, `location.href`, and the optional marker.

That gives you a stable human-to-agent handoff without pretending that Chrome’s internal tab ID, CDP’s target ID, and MCP’s page ID are the same thing.

## Minimal browser-side logic, without clipboard concerns

This is the core logic the extension/helper would need. It intentionally returns data; your separate transport can deliver it to the agent.

```js
async function getCurrentTabHandoff() {
  const [tab] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true
  });

  if (!tab || tab.id == null) {
    throw new Error("No active tab found.");
  }

  const targets = await chrome.debugger.getTargets();
  const target = targets.find(
    (candidate) => candidate.type === "page" && candidate.tabId === tab.id
  );

  return {
    kind: "chrome-devtools-tab-handoff",
    observedAt: new Date().toISOString(),
    chromeTab: {
      tabId: tab.id,
      windowId: tab.windowId,
      index: tab.index,
      active: tab.active,
      title: tab.title,
      url: tab.url
    },
    debugTarget: target
      ? {
          targetId: target.id,
          type: target.type,
          attached: target.attached,
          title: target.title,
          url: target.url
        }
      : null,
    routingHint: "For Chrome DevTools MCP, call list_pages and then select_page(pageId). For raw CDP, use debugTarget.targetId."
  };
}
```

The extension would need permissions appropriate to the data it reads. In a minimal version, that means `tabs` for `url`/`title` and `debugger` for `chrome.debugger.getTargets()`.

## References

- [Chrome DevTools MCP README: connecting with `--browser-url`, security warning, and page ID routing](https://github.com/ChromeDevTools/chrome-devtools-mcp)
- [Chrome DevTools MCP tool reference: `list_pages` and `select_page`](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/tool-reference.md)
- [Chrome DevTools MCP releases: v1.3.0 includes page title in `list_pages` output](https://github.com/ChromeDevTools/chrome-devtools-mcp/releases)
- [Chrome Extensions Tabs API](https://developer.chrome.com/docs/extensions/reference/api/tabs)
- [Chrome Extensions Debugger API](https://developer.chrome.com/docs/extensions/reference/api/debugger)
- [Chrome DevTools Protocol Target domain](https://chromedevtools.github.io/devtools-protocol/tot/Target/)
