# Getting started with @habemus-papadum/aiui-dock

Mount `<VoiceDock />` once beside the app and the page can be driven by voice with no external
host at all — no browser extension, no CDP driver. The template scaffolded by `create-aiui` and
the notebook gallery both mount it.

```tsx
import { VoiceDock } from "@habemus-papadum/aiui-dock";
```

One `aiui` pill, carrying the sessions' combined status dot, expands into the row. Five pills,
five panes:

- **oracle** — an OpenAI Realtime session over the page's tools: the control strip (start,
  park, stop, the mic meter), the ledger viewer, usage, and the woven prompt as sent — the
  `Tools:` section in it is rendered from the same tool document the page's registry lists.
- **live** — a GPT-Live session and a backend picker: a Responses model with the key in this
  browser, the vendor-hosted backend, and, when the dev server's live routes answer, the
  server's Responses and Claude Code. Captions, the task table, the session config as sent.
- **tools** — the page's ToolLog: every call with who made it, the inventory, the document
  as rendered.
- **key** — one OpenAI key for both engines. A dev key is used when the dev server injected
  one (`aiui({ devKeys: ["openai"] })`); otherwise paste one — it stays in this browser's
  localStorage for the site and goes only to `api.openai.com`.
- **source** — the page's own source files, as a tree, each opening syntax-coloured with line
  numbers. Shown only when the page can read them: a dev server (which lists its workspace), or
  a site built with `aiui({ sources: "ship" })`. The listing and the text are the ones the
  `sources` and `source` page tools hand an agent.

The dock is agent chrome (`data-aiui-chrome`): the `read-page` tool never reads it as the page.
