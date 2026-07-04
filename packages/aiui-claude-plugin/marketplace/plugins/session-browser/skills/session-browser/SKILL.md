---
name: session-browser
description: Loaded when this aiui session's Chrome DevTools MCP is attached to a shared, user-visible browser. Covers routing to the browser tab named in an aiui intent-tool prompt (tab ids are hints; MCP pageIds come from list_pages). Etiquette guidance is still being drafted.
---

# Session browser

The browser this session drives through the Chrome DevTools MCP is **shared with the user** — the
tabs you act on are the tabs they are looking at.

## Routing to the tab an intent-tool prompt came from

Prompts delivered by the aiui channel may begin with a context block like:

> It was submitted from the browser tab "spectra · absorption viewer" at http://localhost:5199/
> (chrome tab id 123456, window id 987654, tab index 4, CDP target id A1B2C3…).

Those ids come from three **different namespaces**. Do not pass one where another is expected:

| Id in the prompt | Namespace | What you can do with it |
| ---------------- | --------- | ----------------------- |
| `chrome tab id`, `window id`, `tab index` | Chrome extension Tabs API | Correlation hints only. No MCP tool accepts them. Tab index drifts as tabs move. |
| `CDP target id` | Chrome DevTools Protocol `Target` domain | Only useful with raw CDP access (`Target.getTargets` → `Target.attachToTarget`). Not accepted by the MCP tools. |
| `pageId` | Chrome DevTools MCP | The **only** id `select_page` accepts — and it exists only in `list_pages` output. Never guess it, never assume it equals the others. |

The workflow:

1. Call `list_pages`.
2. Match the intended page by **URL and title** from the prompt's context block.
3. Call `select_page` with the **pageId `list_pages` returned** for that entry.
4. Verify you got the right page — evaluate `({ href: location.href, title: document.title })`
   and compare against the context block before acting.

If several tabs show the same URL and title (duplicate tabs of one app), disambiguate by
evaluating a marker in each candidate: pages served in the aiui session browser carry the tab
stamp on the document — `document.documentElement.dataset.aiuiTab` — whose JSON `chromeTabId`
you can compare against the prompt's `chrome tab id`.

The prompt's context block may also name the app's **source root** (its Vite root). That is the
code that renders the page in that tab: edit there, and the dev server hot-reloads the tab you
just selected.

## Etiquette (drafted, not yet in force)

Detailed etiquette — announcing actions, preserving the user's tabs — is drafted in this repo's
`packages/aiui-claude-plugin/drafts/session-browser-skill.md`, pending review; until it lands, no
special behavior is required beyond common sense in a shared browser.
