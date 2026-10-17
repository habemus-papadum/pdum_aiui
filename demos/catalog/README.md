# demo: catalog

The aiui-viz [catalog](../../packages/aiui-viz/CATALOG.md) rendered as a page: every piece the
package provides — the substrate, the components, the containers, the agent surface, the sister
packages — with the piece itself shown live under the entries that can be shown. The text IS the
catalog file, read at build time; the specimens are the real components over one damped wave
whose frequency, damping and shape every specimen shares, so a slider, a scrub pill, a knob in an
equation and a node in a diagram all move the same thing. Hover inside a specimen for the stamps
an agent reads.

It rides the gallery like every other demo (the `aiui.sitePage` marker; `pnpm demo`, then
`/catalog`) and runs standalone:

```sh
pnpm dev      # this page alone (Vite)
```

See [CLAUDE.md](./CLAUDE.md) for how the page is built and how to add a specimen.
