# Screen capture demo

Use `pnpm dev` here, or `/screen-capture` in the gallery. This demo uses the reusable
`@habemus-papadum/aiui-screen-capture` package. It captures and previews locally; no keys or
network media transport are needed.

Keep the aiui conventions: scoped durable ownership in `model/store.ts`, disposable cells and
actions in `model/graph.ts`, components in `ui/`, and a `SitePage`/`DemoCard` export. The aiui Vite
plugin and PageBoundary are required. Styles are scoped under `.screen-demo` and use aiui-design.

Capture is application-owned and survives graph HMR. Page deactivation stops it. Preview cleanup
must not stop capture. A remounted DOM crop target must be explicitly reselected. The landing
card is static and never requests capture permissions. Starting capture requires a browser user
gesture; agent actions operate on an existing capture.

Browser tests live in `packages/aiui-screen-capture/test/browser`, including the demo's responsive
smoke check. Run `pnpm -C packages/aiui-screen-capture test:browser` from the repo root.
