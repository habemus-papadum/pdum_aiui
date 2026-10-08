# Getting started

```sh
npm install @habemus-papadum/aiui-design
```

```ts
import "@habemus-papadum/aiui-design/site.css";
```

One import dresses the page: fonts, tokens, element defaults, and a skin for every stable
class `@habemus-papadum/aiui-viz` emits. Write your page's own CSS unlayered and it wins over
the sheet without specificity games.

For the places CSS cannot reach — a canvas, an SVG stroke, an Observable Plot option — the
theme module carries the same palette as literals:

```ts
import { CHART, plotStyle, TOKENS } from "@habemus-papadum/aiui-design";
```

The language itself — what the tokens mean, which face does which job, how a cell or a
control should look — is `DESIGN.md` at the package root. Read it before styling anything.
