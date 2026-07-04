# @habemus-papadum/aiui-dev-overlay

Browser-side aiui tools for a page under development — dev-gated, double-injection safe,
Shadow-DOM isolated, dependency-free. The bundled Vite plugin (`./vite`) injects and mounts them
for you; importing and mounting manually stays available for custom setups.

The headline export is the **web intent tool**: a floating widget that collects intent (a text
panel today; richer modalities are the roadmap) and streams it over the aiui channel's binary
websocket protocol to the MCP server, which lowers it into a prompt for the Claude Code session.
Design doc: the repo's *Web Intent Tool* guide page.

## Install

```sh
npm install @habemus-papadum/aiui-dev-overlay
```

## Usage

One line of Vite config is the whole integration — no app code:

```ts
// vite.config.ts
import aiuiDevOverlay from "@habemus-papadum/aiui-dev-overlay/vite";
import { defineConfig } from "vite";

export default defineConfig({ plugins: [aiuiDevOverlay()] });
```

Launch your app with `aiui vite dev`: the plugin mounts the intent tool into every served page and
wires it to the running channel server. It is dev-server-only (`apply: "serve"`), so nothing leaks
into production builds.

Options (all optional):

| Option | Default | Meaning |
| ------ | ------- | ------- |
| `format` | `"text-concat"` | The message format the mounted tool speaks — selects the bundled modality by its wire name. This is where an app declares its intent-tool format. |
| `sourceRoot` | the resolved Vite root | The app's source location, seeded as `window.__AIUI__.sourceRoot` and sent with every intent so lowered prompts can say where the page's code lives. |
| `port` | `process.env.VITE_AIUI_PORT` | The channel server port (normally injected by `aiui vite`). |
| `mount` | `true` | Set `false` to keep the port/source injection but mount from app code (custom modalities). |

Every submission also carries **client context** on its hello — the tab's live url/title, the
tab identity stamped by the aiui DevTools extension (`data-aiui-tab`), and the plugin-seeded
source root — which the channel server folds into the lowered prompt. How that is assembled,
what each piece degrades to without its source, and the wire shape are in this package's
**Client Context** guide (`docs/client-context.md`).

Outside Vite, mount manually and pass `{ port }` explicitly:

```ts
import { mountIntentTool } from "@habemus-papadum/aiui-dev-overlay";
mountIntentTool({ port: 12345 });
```

The widget's 🔍 button opens the server's `/debug` lowering-trace viewer.

### How the port reaches the page (subtle — don't "simplify" this)

You might expect the widget to just read `import.meta.env.VITE_AIUI_PORT` (which `aiui vite`
exports). It can't, and the reason is worth knowing: `import.meta.env.*` is **not a runtime
lookup** — every bundler substitutes it when *it* compiles the file. This package ships prebuilt,
and its own library build already replaced `import.meta.env` with an empty object frozen into
`dist/`. By the time *your* dev server serves that code there is no `import.meta.env` text left to
substitute, so your env can never reach it.

The port therefore travels at **runtime**: `aiui vite` sets `VITE_AIUI_PORT` in the dev-server
process → the plugin reads it there and (a) generates the virtual mount module with the port
inlined, and (b) seeds `window.__AIUI__.port` for manually-mounted setups and the aiui DevTools
panel. Resolution order in the widget: `{ port }` option → `window.__AIUI__.port` →
`import.meta.env.VITE_AIUI_PORT` (that last one only works when the overlay is bundled from
source, as this repo's own tests do).

### Custom modalities

The tool is pluggable — a modality pairs a panel UI with the wire stream format it speaks. Since
modalities are functions, they can't be passed through `vite.config`; disable the plugin's
auto-mount and mount from app code instead:

```ts
// vite.config.ts — keep the port injection, skip the auto-mount.
export default defineConfig({ plugins: [aiuiDevOverlay({ mount: false })] });
```

```ts
import { mountIntentTool, textModality, type IntentModality } from "@habemus-papadum/aiui-dev-overlay";

const shout: IntentModality = {
  format: "text-concat",
  label: "Shout",
  mount(container, ctx) {
    const button = document.createElement("button");
    button.textContent = "SEND LOUDLY";
    button.onclick = async () => {
      const thread = await ctx.openThread();
      await thread.finish({ text: "MAKE IT POP" });
      ctx.setStatus("sent ✓");
    };
    container.append(button);
    return undefined;
  },
};

mountIntentTool({ modalities: [textModality(), shout] });
```

### Also here

- `mountDevOverlay` — the original inspection-overlay scaffold (element picking: TODO).
- `connectIntentSocket` / `encodeFrame` — the ~40-line browser client for the channel's binary
  `/ws` protocol, reusable outside the widget.
