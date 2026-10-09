# The prompt vocabulary

What a prompt lowered by the aiui intent tool looks like when it reaches the Claude Code
session, and where each piece is defined. This page is a map, not the text: the text lives in
two places that tests keep honest.

- **The teaching prose** is the channel's MCP server instructions (`INSTRUCTIONS` in
  `src/server.ts`), which Claude Code reads once per session. A vocabulary test asserts it
  mentions every marker and sidecar the renderers emit, so a new marker cannot ship untaught.
- **The renderers** are `@habemus-papadum/aiui-lowering-pipeline`'s `render.ts` (markers and
  sidecars) and this package's `prompt-context.ts` (the preamble) and `intent-fin.ts` (the
  final join). Their exact output for recorded interactions is the **corpus** under
  `corpus/` — readable text files produced by `*.corpus.test.ts`, a baseline (not a contract)
  that any change to a renderer updates with a reviewed diff.

## The shape of a lowered prompt

```
<preamble sections, blank-line separated>

---

<the turn's body: transcript text with markers inline where they happened>
```

The preamble is fixed at connect time (`promptContextSections`): an opening line that says
whether an aiui app was detected, the `[current tab: <tab …/>]` marker, the relative-paths line
and the page-tools note for an aiui app, and a DevTools-alignment note when the state is known.
The turn adds the transcription warning only when speech-transcribed text is present.

## Markers and sidecars

| Marker | Meaning | Rendered by |
| --- | --- | --- |
| `[screenshot located at <path>]`, `[pasted image located at …]`, `MISSING` | a captured image saved at a path; clipboard content; pixels never captured | `renderShot` |
| `<screenshot-metadata>` with `<element>` and `<cell>` children | the UI elements a capture framed (capped: 8 elements, 4 cells) | `renderShotMetadata` |
| `[selected text: "…"]` | an on-screen selection, with a `<selection-metadata>` sidecar | `renderAppSelection`, `selectionMetadata` |
| `` [code selection at `<loc>`: `<code>`] `` | contributed code; past 240 characters a `(N lines)` header and a fence, elided past 50 lines | `renderCodeSelection` |
| `[current page changed: <tab …/>]`, `[current tab changed: <tab …/>]` | the user navigated or turned to another tab mid-turn | `renderNavigation`, `renderTabSwitch` |
| `<tab …/>` | the canonical tab record (url, title, `aiui-app`, `source-root`, the host's ids) | `renderTabRecord` |

The ids on a tab record are correlation hints for the Chrome DevTools MCP, never its own
`pageId`; the session-browser skill covers that workflow.

## History

Until 2026-10-09 this reference was a generated document (`render-audit.mts`), a hand-annotated
rendering of the same markers. It stopped running when a cleanup removed a function it imported,
and its hand-pasted tool descriptions had drifted. The corpus replaces it: it is produced by the
code, and it is what the prompt-toolkit migration (docs/proposals/structured-prompts-review.md)
measures itself against.
