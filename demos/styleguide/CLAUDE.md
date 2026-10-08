# demos/styleguide — the design system's sheet

This demo is the visual acceptance test for `@habemus-papadum/aiui-design`: every role,
token, and component on one page. Unlike the other demos it has no subject of its own — its
"model" is a tiny control surface that exists so the real aiui-viz widgets can be exhibited
live, and its page is a catalogue of specimens.

Rules:

- The look comes from the package, not from here. `src/styles.css` holds only the sheet's
  own chrome (swatch grid, specimen labels, exhibit rows), scoped under `.styleguide`. If a
  specimen looks wrong, fix `packages/aiui-design/src/site.css` (after `DESIGN.md`), never
  this demo.
- Keep every specimen honest: a widget on this page is the real component with the real
  class names, so a styling change that breaks a widget breaks it here first.
- Add a specimen when the package gains a rule; remove one when a role is retired.

Run it standalone with `pnpm dev` here, or in the gallery via `pnpm demo` → `/styleguide`.
