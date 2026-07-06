# Installation

What you need on your machine, and what goes into a project. When everything here is in place,
[Getting Started](./getting-started) walks the full loop.

::: danger First
Read [⚠️ Read Before Running](./warning). `aiui claude` loads a custom channel into your session
and can launch Claude Code with permissions skipped.
:::

## Machine prerequisites

- **Node ≥ 24** and a package manager (npm/pnpm).
- The **[Claude Code](https://claude.com/claude-code) CLI** (`claude`) on your PATH, logged in.
- **Chrome.** Interactive launches offer to install a managed
  [Chrome for Testing](./chrome#chrome-for-testing-the-recommended-browser) under `~/.cache/aiui/chrome/` — say yes;
  branded Chrome ≥ 137 won't auto-load the DevTools extension and newer versions restrict the
  debug port setup aiui relies on.
- **`OPENAI_API_KEY`** in your shell if you want real voice transcription and corrections —
  the intent pipeline's model calls run in the channel process and read only this environment
  variable ([why env-only](./config#the-intent-pipeline-openai-key)). Without it everything
  still runs; the voice paths say plainly that they're unavailable.

## The disposable sandbox (nothing to install)

```sh
npx @habemus-papadum/aiui demo my-demo
```

Scaffolds a standalone, self-contained sample app in its own git repo — the fastest way to try
the loop without touching a real project. Details in
[Getting Started](./getting-started#the-quickest-start-a-disposable-demo).

## Adding aiui to your own app

In a Vite-based project:

```sh
npm install -D @habemus-papadum/aiui @habemus-papadum/aiui-dev-overlay
```

- **`@habemus-papadum/aiui`** — the CLI: `aiui claude` (session + channel + session browser)
  and `aiui vite` (your dev server, wired to the channel).
- **`@habemus-papadum/aiui-dev-overlay`** — the Vite plugin + the intent tool. One line in
  `vite.config.ts`:

```ts
import aiuiDevOverlay from "@habemus-papadum/aiui-dev-overlay/vite";

export default defineConfig({
  plugins: [aiuiDevOverlay({ locator: true })],
});
```

The plugin is dev-server-only (it can never leak into a production build), auto-mounts the
intent tool, wires the channel port, and — with `locator` on — stamps your elements with the
source locations that make screenshots and selections resolve to code. Options (including the
intent pipeline's `tier` and other knobs) are covered in
[Using the Intent Overlay](./intent-overlay#configuring-the-pipeline) and
[Configuration](./config).

Optionally, for apps built to the [frontend-for-agents](./frontend-for-agents) methodology:

```sh
npm install @habemus-papadum/aiui-viz
```

## Working on this repo itself

`pnpm install && pnpm build`, then the `./aiui` wrapper (or `pnpm aiui`). `pnpm demo` serves
the reference notebooks straight from the checkout; `pnpm workbench` runs the multimodal
interaction lab. See [Developing pdum_aiui](./development).
