# aiui demo playground

This directory is a scaffolded, disposable aiui demo — a sandbox the user is exploring the aiui
workflow in. Ground rules for working here:

- **The app is scenery.** `src/main.ts` renders a fake "spectra" viewer purely so there's
  something to point at and modify. Redesign it, extend it, replace it — that's the point of the
  demo. Prefer small, visible changes the user can watch land.
- **Don't remove the integration.** The `aiuiDevOverlay()` plugin in `vite.config.ts` is what
  mounts the intent tool and connects it to this session's channel. The demo stops working
  without it.
- The dev server runs via `npm run dev` (which is `aiui vite dev` — it injects the channel port
  as `VITE_AIUI_PORT`). Plain `vite` also serves the app, but the intent tool won't find the
  channel.
- This is a standalone git repo scaffolded by `aiui demo`; commit freely — history here belongs
  to the user's sandbox and goes nowhere else.
