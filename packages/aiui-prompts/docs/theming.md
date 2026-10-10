# Inspector styling and host integration

The inspector mounts semantic HTML and does not import a stylesheet or choose a design system.
The optional base stylesheet supplies a neutral layout. Its public `--prompt-*` tokens inherit
from your wrapper; no default token declarations on the inspector shadow those inherited values.
Each inspector, or a comparison containing two inspectors, can therefore have its own theme.

```ts
import "katex/dist/katex.min.css";
import "@habemus-papadum/aiui-prompts-inspector/style.css";
import { mountInspector } from "@habemus-papadum/aiui-prompts-inspector";

const wrapper = document.querySelector<HTMLElement>("#prompt-audit")!;
wrapper.style.setProperty("--prompt-accent", "#12615a");
wrapper.style.setProperty("--prompt-image-max-height", "20rem");
const inspector = mountInspector(wrapper, savedRecord);
// Dispose when the host removes the view.
// inspector.dispose();
```

Base selectors put their class qualifiers in `:where(...)` and are scoped to a
`.prompt-inspector` or `.prompt-comparison` root. There are no page resets, external imports,
or aiui token references in the base stylesheet. Normal host class rules override it without
`!important`. Host global rules can also override it: scope page heading and button styles to
the page chrome if the embedded inspector should retain its own typography.
Ordinary selectors have zero specificity; the dialog backdrop adds only its pseudo-element.

## Optional themes

The aiui bridge consumes the existing host design tokens. It does not load fonts, mutate global
tokens, or add a dependency on a design package. The host supplies its usual aiui tokens/fonts.

```ts
import "@habemus-papadum/aiui-prompts-inspector/themes/aiui.css";
wrapper.dataset.promptTheme = "aiui";
```

The `terminal.css` example is an independent host palette with compact spacing and a dark
surface. It is not a dark variant of another design system.

```ts
import "@habemus-papadum/aiui-prompts-inspector/themes/terminal.css";
wrapper.dataset.promptTheme = "terminal";
// Return to neutral base defaults:
wrapper.dataset.promptTheme = "neutral";
```

Change the attribute on the same wrapper to switch themes. No remount, record load, compilation,
or controller mutation is needed: selection, folds, opened details, pinned previews, and comparison
state remain intact. The workbench's **Inspector theme** selector demonstrates this directly.
Put a theme attribute on the nearest shared wrapper for both sides of a comparison. An inner wrapper
can instead select an independent theme. The theme classes assign tokens on their wrapper; place
your own overrides on that same wrapper or a closer ancestor of the inspector:

```css
.my-audit {
  --prompt-font-size: 0.9rem;
  --prompt-panel-columns: minmax(14rem, 0.8fr) minmax(0, 1fr) minmax(0, 1.1fr);
  --prompt-popup-z-index: 200;
}
```

## Public tokens

Defaults are fallback values at the point of use. Values accept ordinary CSS for the named
property; dimensions can use `rem`, viewport units, `min()`, or `clamp()`. Token names below are
the supported styling contract; theme files are useful examples rather than required inheritance.

| Token | Neutral default / purpose |
| --- | --- |
| `--prompt-surface`, `--prompt-ink` | `#fff`, `#30343b`; widget and popup surface/text |
| `--prompt-muted`, `--prompt-rule` | `#626973`, `#ccd0d5`; secondary text and rules |
| `--prompt-accent`, `--prompt-error` | `#2457a7`, `#9b3b2a`; interaction and errors |
| `--prompt-color-scheme` | `light`; native controls inside the view |
| `--prompt-font-ui` | `system-ui, sans-serif`; controls and metadata |
| `--prompt-font-reading` | `Georgia, serif`; Markdown prose |
| `--prompt-font-mono` | System monospace; raw output, JSON, and code |
| `--prompt-font-numeric` | Inherits UI font; contribution badges use tabular numerals |
| `--prompt-font-size`, `--prompt-font-size-small` | `0.875rem`, `0.8rem`; UI and secondary labels |
| `--prompt-font-size-reading`, `--prompt-font-size-mono` | `1rem`, `0.8rem`; prose and raw/code |
| `--prompt-heading-size` | `1.1rem`; panel headings (Markdown headings scale with prose) |
| `--prompt-line-height` | `1.5`; UI line height |
| `--prompt-reading-line-height`, `--prompt-code-line-height` | `1.55`; prose and code line heights |
| `--prompt-radius` | `0`; buttons and popups |
| `--prompt-space`, `--prompt-space-small`, `--prompt-section-gap` | `1rem`, `0.6rem`, `1.5rem`; spacing |
| `--prompt-control-padding`, `--prompt-control-gap`, `--prompt-row-gap` | `0.2rem 0.4rem`, `0.5rem`, `0.2rem` |
| `--prompt-panel-gap` | `1rem`; spacing between composition/raw/preview panels |
| `--prompt-panel-columns` | `minmax(12rem, 0.7fr) minmax(0, 1.1fr) minmax(0, 1fr)` |
| `--prompt-comparison-columns` | `minmax(0, 1fr) minmax(0, 1fr)`; before/after layout |
| `--prompt-comparison-panel-columns` | `minmax(0, 1fr) minmax(0, 1fr)`; raw/preview below each tree |
| `--prompt-narrow-columns` | `minmax(0, 1fr)`; all grids at viewport widths up to `1000px` |
| `--prompt-tree-indent`, `--prompt-tree-max-height` | `0.7rem`, `42rem`; composition tree |
| `--prompt-comparison-tree-max-height`, `--prompt-json-max-height` | `15rem`, `28rem`; scroll limits |
| `--prompt-image-max-height` | `24rem`; inline preview image bound, keeping its aspect ratio |
| `--prompt-popup-width`, `--prompt-popup-max-height` | `28rem`, `70vh`; raw-image hover/pinned preview |
| `--prompt-popup-image-max-height` | `45vh`; image bound within that popup |
| `--prompt-popup-z-index` | `1000`; stacking of anchored image previews |
| `--prompt-compact-max-height` | `24rem`; condensed preview's scrolling content area |
| `--prompt-dialog-width` | `90vw`; full inspector opened from a condensed preview |
| `--prompt-dialog-backdrop` | `#0006`; backdrop behind the full-view modal |

Popup width is also capped to the viewport minus `1rem`. The image popup anchors to its raw marker,
flips above when necessary, and clamps to the viewport with an eight-pixel margin. It follows scroll,
resize, and image loading. Unpinned previews close on pointer exit or focus loss; Escape dismisses a
pinned preview and restores marker focus. Browsers supporting native popovers render it in the top
layer while preserving inherited themes, including inside transformed hosts. The fixed-position
fallback for older browsers requires an untransformed containing ancestor. Inline images and popup images have
`width: auto; height: auto; max-width: 100%` and use `object-fit: contain`; they do not stretch to
fill their columns. Image buttons preserve the same maximum width. Hosts can lower the image
height token independently of the popup height token.

## State selectors and layout replacement

These classes identify visual roles, rather than semantic identity:

| Role | Classes / states |
| --- | --- |
| Inspector / comparison | `.prompt-inspector`, `.prompt-inspector-content`, `.prompt-comparison` |
| Embedded / expanded | `.prompt-compact`, `.prompt-compact-output`, `.prompt-inspector-dialog` |
| Panels | `.prompt-panels`, `.prompt-tree`, `.prompt-raw`, `.prompt-preview` |
| Tree | `.prompt-tree-item`, `.prompt-tree-row`, `.prompt-tree-children` |
| Contribution display | `.prompt-tree-cost`, `.prompt-cost-legend` |
| Raw output | `.prompt-raw-span`, `.prompt-fingerprint` |
| Preview | `.prompt-preview-block`, `.prompt-equation`, `.prompt-partial-fold` |
| Images | `.prompt-inline-image`, `.prompt-inline-image-frame`, `.prompt-inline-image-caption`, `.prompt-image-popup` |
| Details | `.prompt-provenance`, `.prompt-json`, `.prompt-toolbar`, `.prompt-note`, `.prompt-error` |

`[data-selected="true"]` marks a selected tree row, raw range, mapped preview node, or atomic image.
Outline controls expose `aria-expanded`; content-fold controls expose `aria-pressed`; native JSON
details use `[open]`. `[data-partial-fold="true"]` identifies a preview block retained whole while
part of its raw text is folded. `[data-precision]` describes mapping precision, not a CSS requirement;
`atomic-asset` marks an image placement. Part/occurrence IDs are artifact addresses and must not be
hard-coded as cross-record theme selectors. Selection and folding remain controller responsibilities.

You can omit the base stylesheet entirely and style these roles, or replace only a layout rule:

```css
.my-audit .prompt-panels {
  display: flex;
  flex-direction: column;
}
.my-audit .prompt-tree { max-height: 18rem; }
```

Keep visible focus indicators and the distinction between selection, outline disclosure, and
content folding. Do not reset `font` or `font-family` on all inspector descendants. Import KaTeX's
stylesheet and leave its `.katex` descendants' font families, metrics, and positioning intact;
changing `--prompt-font-reading` styles the surrounding prose without replacing math glyph fonts.

CSS contract tests inspect scoping, fallback declarations, exports, and DOM state preservation.
They deliberately do not treat a DOM emulator as proof of CSS-variable resolution, font metrics,
image sizing, or responsive layout. Those require the workbench in a real browser.
