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

## Starting a fresh app (the SolidJS starter)

```sh
pnpm create @habemus-papadum/aiui my-app    # or: npm create @habemus-papadum/aiui my-app
```

This is both the fastest way to try the loop without touching a real project **and** the way to
start a keeper. It scaffolds a standalone SolidJS 2.0 app in its own git repo, opening on a banner
telling you the page is alive — arm the overlay and describe the app you want — with the
[frontend-for-agents](./frontend-for-agents) methodology already in miniature: durable roots, a
disposable `cell()` graph, an agent tool surface, an `.envrc`, and a `CLAUDE.md` for the agent. Its
starter content — a Maurer rose on two sliders — is built to be rebuilt. Re-running the command on
the same directory continues it; it never overwrites.

The [frontend user guide](./frontend-user-guide) is how to write into it.

## Adding aiui to your own app

In a Vite-based project:

```sh
npm install -D @habemus-papadum/aiui @habemus-papadum/aiui-source-processor
```

- **`@habemus-papadum/aiui`** — the CLI: `aiui claude` (session + channel + session browser)
  and `aiui vite` (your dev server, opened in the session browser).
- **`@habemus-papadum/aiui-source-processor`** — the Vite plugin (the locator pass). One line in
  `vite.config.ts`:

```ts
import aiui from "@habemus-papadum/aiui-source-processor";

export default defineConfig({
  plugins: [aiui()],
});
```

The plugin stamps your elements with the source locations that make screenshots and
selections resolve to code, and injects cell/control identities; it is build-shape aware
(dev serves stamps, production builds keep only the factory identities). The intent client —
the session browser's side panel, or the channel-served `/intent/` page — carries channel
connectivity; the app wires nothing. Knobs are covered in [Configuration](./config).

Optionally, for apps built to the [frontend-for-agents](./frontend-for-agents) methodology:

```sh
npm install @habemus-papadum/aiui-viz
```

## Working on this repo itself

`pnpm install && pnpm build`, then the `./aiui` wrapper (or `pnpm aiui`). `pnpm demo` serves
the reference notebooks straight from the checkout. See [Developing pdum_aiui](./development).
