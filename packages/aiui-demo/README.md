# @habemus-papadum/aiui-demo

The playground for the [web intent tool](../../docs/guide/web-intent-tool.md): a fake "scientific
UI" with the widget integrated the canonical way — the `aiuiDevOverlay()` plugin in
`vite.config.ts`, nothing in app code. Never published — it exists to be run, poked at, and
extended as the dev tool grows.

## Run it

```sh
# terminal 1 — a Claude Code session with the channel attached
./aiui claude

# terminal 2 — this app, served by aiui vite (injects VITE_AIUI_PORT)
pnpm demo
```

Open the printed URL, click the **✳ aiui** button, type something, hit Enter — it lands in the
session in terminal 1 as a prompt. The **🔍** button opens the lowering-trace debugger
(`/debug` on the channel port).

Also works without a channel (`pnpm --filter @habemus-papadum/aiui-demo dev`): the app renders
and the widget reports it has no port when you try to send.

## What to look at

- `vite.config.ts` — the one-line integration a real app copies (and a pointer to why the port
  must travel through the plugin).
- `src/main.ts` — pure scenery: proof the tool needs no app code.
- Traces land in `.aiui-cache/` under wherever `aiui claude` ran (gitignored).
