# Prompt rendering reference

How the intent lowering renders each captured item into the prompt an agent reads — every render path with its actual output, generated from the real renderer. All cases use `cwd: /repo/app` unless noted, so relativization is visible. Each case shows the RAW input value (the `ComposedItem` fed to the renderer, as JSON — `rect` fields omitted, the renderer never reads them) and the exact rendered text. Each section opens with the input schema once; cases only vary the values. Only section G mixes in `kind: "text"` transcript runs — everywhere else the input is purely the item under audit.

> **Generated file — do not edit.** Rebuild with `pnpm -C packages/aiui-claude-channel render-audit --docs` after changing the renderer. The same script (without `--docs`) produces the annotatable render-audit working pair in `audit.local/` — the mechanism for iterating on these renderings.

## A. Screenshots — the ONE form (bracket line + `<screenshot-metadata>` when elements were located)

Input schema (`ComposedItem`, `kind: "shot"` — the fields the renderer reads):

````ts
{
  kind: "shot";
  marker: string;       // stream identity (shot_N)
  path?: string;        // saved image on disk; absent → capture failed
  viewport?: boolean;   // whole-viewport shot (no element metadata by design)
  origin?: "paste";     // clipboard image, not the screen
  share?: {             // present when a video share's sampler took the frame
    ordinal: number; mode: "smart" | "continuous"; offsetMs: number };
  components?: Array<{  // elements located under the capture rect
    component: string;
    source?: string;                 // file:line:col; "unknown" → attribute dropped
    containment?: "within";          // enclosing anchor — context, not framing
    cells?: Array<{ name: string; source?: string }> }>;
}
````

### 1. Viewport shot (bare bracket line, no element info by design)

Trigger: `viewport: true`.

Input:

````json
{
  "kind": "shot",
  "marker": "shot_1",
  "path": "/repo/app/.aiui-cache/traces/t1/shot_1.png",
  "viewport": true
}
````

Rendered:

````text
[screenshot located at .aiui-cache/traces/t1/shot_1.png (full viewport)]
````

### 2. Region shot, no located components

Trigger: empty `components`. Bracket line only.

Input:

````json
{
  "kind": "shot",
  "marker": "shot_1",
  "path": "/repo/app/.aiui-cache/traces/t1/shot_1.png",
  "components": []
}
````

Rendered:

````text
[screenshot located at .aiui-cache/traces/t1/shot_1.png]
````

### 3. Region shot with elements and cells (the rich block)

Trigger: components with sources and cells; one `containment: "within"` anchor; one `source: "unknown"` (dropped attr); one cell without a source.

Input:

````json
{
  "kind": "shot",
  "marker": "shot_1",
  "path": "/repo/app/.aiui-cache/traces/t1/shot_1.png",
  "components": [
    {
      "component": "Legend",
      "source": "/repo/app/src/Legend.tsx:30:2",
      "cells": [
        {
          "name": "colorScale",
          "source": "/repo/app/src/Legend.tsx:41:8"
        },
        {
          "name": "ticks"
        }
      ]
    },
    {
      "component": "Plot",
      "source": "unknown"
    },
    {
      "component": "Panel",
      "source": "/repo/app/src/Panel.tsx:5:1",
      "containment": "within"
    }
  ]
}
````

Rendered:

````text
[screenshot located at .aiui-cache/traces/t1/shot_1.png]
<screenshot-metadata path=".aiui-cache/traces/t1/shot_1.png">
  <element name="Legend" source="src/Legend.tsx:30:2">
    <cell name="colorScale" source="src/Legend.tsx:41:8"/>
    <cell name="ticks"/>
  </element>
  <element name="Plot"/>
  <element name="Panel" source="src/Panel.tsx:5:1" containment="within"/>
</screenshot-metadata>
````

### 4. Cell overflow (>4 cells → `cells-omitted`)

Trigger: 6 cells on one element; the first 4 list, 2 collapse.

Input:

````json
{
  "kind": "shot",
  "marker": "shot_1",
  "path": "/repo/app/.aiui-cache/traces/t1/shot_1.png",
  "components": [
    {
      "component": "Dashboard",
      "source": "/repo/app/src/Dash.tsx:1:1",
      "cells": [
        {
          "name": "cell1"
        },
        {
          "name": "cell2"
        },
        {
          "name": "cell3"
        },
        {
          "name": "cell4"
        },
        {
          "name": "cell5"
        },
        {
          "name": "cell6"
        }
      ]
    }
  ]
}
````

Rendered:

````text
[screenshot located at .aiui-cache/traces/t1/shot_1.png]
<screenshot-metadata path=".aiui-cache/traces/t1/shot_1.png">
  <element name="Dashboard" source="src/Dash.tsx:1:1" cells-omitted="2">
    <cell name="cell1"/>
    <cell name="cell2"/>
    <cell name="cell3"/>
    <cell name="cell4"/>
  </element>
</screenshot-metadata>
````

### 5. Element overflow (>8 components → `elements-omitted`)

Trigger: 10 components; document order keeps the first 8.

Input:

````json
{
  "kind": "shot",
  "marker": "shot_1",
  "path": "/repo/app/.aiui-cache/traces/t1/shot_1.png",
  "components": [
    {
      "component": "Widget1",
      "source": "/repo/app/src/W1.tsx:1:1"
    },
    {
      "component": "Widget2",
      "source": "/repo/app/src/W2.tsx:1:1"
    },
    {
      "component": "Widget3",
      "source": "/repo/app/src/W3.tsx:1:1"
    },
    {
      "component": "Widget4",
      "source": "/repo/app/src/W4.tsx:1:1"
    },
    {
      "component": "Widget5",
      "source": "/repo/app/src/W5.tsx:1:1"
    },
    {
      "component": "Widget6",
      "source": "/repo/app/src/W6.tsx:1:1"
    },
    {
      "component": "Widget7",
      "source": "/repo/app/src/W7.tsx:1:1"
    },
    {
      "component": "Widget8",
      "source": "/repo/app/src/W8.tsx:1:1"
    },
    {
      "component": "Widget9",
      "source": "/repo/app/src/W9.tsx:1:1"
    },
    {
      "component": "Widget10",
      "source": "/repo/app/src/W10.tsx:1:1"
    }
  ]
}
````

Rendered:

````text
[screenshot located at .aiui-cache/traces/t1/shot_1.png]
<screenshot-metadata path=".aiui-cache/traces/t1/shot_1.png" elements-omitted="2">
  <element name="Widget1" source="src/W1.tsx:1:1"/>
  <element name="Widget2" source="src/W2.tsx:1:1"/>
  <element name="Widget3" source="src/W3.tsx:1:1"/>
  <element name="Widget4" source="src/W4.tsx:1:1"/>
  <element name="Widget5" source="src/W5.tsx:1:1"/>
  <element name="Widget6" source="src/W6.tsx:1:1"/>
  <element name="Widget7" source="src/W7.tsx:1:1"/>
  <element name="Widget8" source="src/W8.tsx:1:1"/>
</screenshot-metadata>
````

### 6. Duplicate elements collapse (a `<For>` over marks shares one source stamp)

Trigger: 27 elements at the SAME source loc — the histogram-bar case (every `<rect>` carries its JSX stamp). They collapse to one line with `count`; identical entries are an inventory of one reference point, not 27 references.

Input:

````json
{
  "kind": "shot",
  "marker": "shot_1",
  "path": "/repo/app/.aiui-cache/traces/t1/shot_1.png",
  "components": [
    {
      "component": "DensityChart",
      "source": "/repo/app/src/ui/DensityChart.tsx:62:23"
    },
    {
      "component": "DensityChart",
      "source": "/repo/app/src/ui/DensityChart.tsx:62:23"
    },
    {
      "component": "DensityChart",
      "source": "/repo/app/src/ui/DensityChart.tsx:62:23"
    },
    {
      "component": "DensityChart",
      "source": "/repo/app/src/ui/DensityChart.tsx:62:23"
    },
    {
      "component": "DensityChart",
      "source": "/repo/app/src/ui/DensityChart.tsx:62:23"
    },
    {
      "component": "DensityChart",
      "source": "/repo/app/src/ui/DensityChart.tsx:62:23"
    },
    {
      "component": "DensityChart",
      "source": "/repo/app/src/ui/DensityChart.tsx:62:23"
    },
    {
      "component": "DensityChart",
      "source": "/repo/app/src/ui/DensityChart.tsx:62:23"
    },
    {
      "component": "DensityChart",
      "source": "/repo/app/src/ui/DensityChart.tsx:62:23"
    },
    {
      "component": "DensityChart",
      "source": "/repo/app/src/ui/DensityChart.tsx:62:23"
    },
    {
      "component": "DensityChart",
      "source": "/repo/app/src/ui/DensityChart.tsx:62:23"
    },
    {
      "component": "DensityChart",
      "source": "/repo/app/src/ui/DensityChart.tsx:62:23"
    },
    {
      "component": "DensityChart",
      "source": "/repo/app/src/ui/DensityChart.tsx:62:23"
    },
    {
      "component": "DensityChart",
      "source": "/repo/app/src/ui/DensityChart.tsx:62:23"
    },
    {
      "component": "DensityChart",
      "source": "/repo/app/src/ui/DensityChart.tsx:62:23"
    },
    {
      "component": "DensityChart",
      "source": "/repo/app/src/ui/DensityChart.tsx:62:23"
    },
    {
      "component": "DensityChart",
      "source": "/repo/app/src/ui/DensityChart.tsx:62:23"
    },
    {
      "component": "DensityChart",
      "source": "/repo/app/src/ui/DensityChart.tsx:62:23"
    },
    {
      "component": "DensityChart",
      "source": "/repo/app/src/ui/DensityChart.tsx:62:23"
    },
    {
      "component": "DensityChart",
      "source": "/repo/app/src/ui/DensityChart.tsx:62:23"
    },
    {
      "component": "DensityChart",
      "source": "/repo/app/src/ui/DensityChart.tsx:62:23"
    },
    {
      "component": "DensityChart",
      "source": "/repo/app/src/ui/DensityChart.tsx:62:23"
    },
    {
      "component": "DensityChart",
      "source": "/repo/app/src/ui/DensityChart.tsx:62:23"
    },
    {
      "component": "DensityChart",
      "source": "/repo/app/src/ui/DensityChart.tsx:62:23"
    },
    {
      "component": "DensityChart",
      "source": "/repo/app/src/ui/DensityChart.tsx:62:23"
    },
    {
      "component": "DensityChart",
      "source": "/repo/app/src/ui/DensityChart.tsx:62:23"
    },
    {
      "component": "DensityChart",
      "source": "/repo/app/src/ui/DensityChart.tsx:62:23"
    }
  ]
}
````

Rendered:

````text
[screenshot located at .aiui-cache/traces/t1/shot_1.png]
<screenshot-metadata path=".aiui-cache/traces/t1/shot_1.png">
  <element name="DensityChart" source="src/ui/DensityChart.tsx:62:23" count="27"/>
</screenshot-metadata>
````

### 7. Missing image (capture denied/unavailable)

Trigger: no `path`. The marker keeps the reference alive.

Input:

````json
{
  "kind": "shot",
  "marker": "shot_2",
  "components": []
}
````

Rendered:

````text
[screenshot shot_2 located at MISSING]
````

### 8. Pasted image (clipboard, not screen)

Trigger: `origin: "paste"` — its own tag so the model can't mistake clipboard for screen.

Input:

````json
{
  "kind": "shot",
  "marker": "shot_1",
  "path": "/repo/app/.aiui-cache/traces/t1/shot_1.png",
  "origin": "paste",
  "components": []
}
````

Rendered:

````text
[pasted image located at .aiui-cache/traces/t1/shot_1.png]
````

### 9. Video-share frame, smart mode (captured on change)

Trigger: `share.mode: "smart"`.

Input:

````json
{
  "kind": "shot",
  "marker": "shot_1",
  "path": "/repo/app/.aiui-cache/traces/t1/shot_1.png",
  "share": {
    "ordinal": 1,
    "mode": "smart",
    "offsetMs": 0
  },
  "components": []
}
````

Rendered:

````text
[screenshot located at .aiui-cache/traces/t1/shot_1.png (captured on change)]
````

### 10. Video-share frame, continuous mode (capture time rides with the path)

Trigger: `share.mode: "continuous"`, offset 12340ms.

Input:

````json
{
  "kind": "shot",
  "marker": "shot_1",
  "path": "/repo/app/.aiui-cache/traces/t1/shot_1.png",
  "share": {
    "ordinal": 1,
    "mode": "continuous",
    "offsetMs": 12340
  },
  "components": []
}
````

Rendered:

````text
[screenshot located at .aiui-cache/traces/t1/shot_1.png at +12.3s]
````

### 11. Path outside cwd stays absolute; XML escaping in names

Trigger: shot path outside cwd; a component named `A<B> & "C"`.

Input:

````json
{
  "kind": "shot",
  "marker": "shot_1",
  "path": "/elsewhere/traces/shot_9.png",
  "components": [
    {
      "component": "A<B> & \"C\"",
      "source": "/repo/app/src/AB.tsx:2:2"
    }
  ]
}
````

Rendered:

````text
[screenshot located at /elsewhere/traces/shot_9.png]
<screenshot-metadata path="/elsewhere/traces/shot_9.png">
  <element name="A&lt;B&gt; &amp; &quot;C&quot;" source="src/AB.tsx:2:2"/>
</screenshot-metadata>
````

## C. Code selections

Input schema (`ComposedItem`, `kind: "code-selection"`):

````ts
{
  kind: "code-selection";
  marker?: string;     // stream identity (code_N)
  text: string;        // the selected code, verbatim
  sourceLoc?: string;  // file:line:col or file:startLine-endLine; absent → MISSING_LOCATION
  lines?: number;      // line count (derived from text when absent)
  url?: string;        // the contributing view's location.href → <tab> record
}
````

### 12. Short code selection with locator (inlined)

Trigger: ≤240 chars.

Input:

````json
{
  "kind": "code-selection",
  "marker": "code_1",
  "text": "const x = 1;",
  "sourceLoc": "/repo/app/src/a.ts:5:1",
  "lines": 1
}
````

Rendered:

````text
[code selection at `src/a.ts:5:1`: `const x = 1;`]
````

### 13. Short code selection, no locator

Trigger: `sourceLoc` absent → `MISSING_LOCATION`.

Input:

````json
{
  "kind": "code-selection",
  "marker": "code_1",
  "text": "let y = 2;"
}
````

Rendered:

````text
[code selection at MISSING_LOCATION: `let y = 2;`]
````

### 14. Short code selection with a contributing view's tab

Trigger: the event carried `url` → the canonical `<tab>` record in metadata.

Input:

````json
{
  "kind": "code-selection",
  "marker": "code_1",
  "text": "const x = 1;",
  "sourceLoc": "/repo/app/src/a.ts:5:1",
  "url": "http://localhost:5173/reader",
  "lines": 1
}
````

Rendered:

````text
[code selection at `src/a.ts:5:1`: `const x = 1;`]
<selection-metadata>
  <tab url="http://localhost:5173/reader"/>
</selection-metadata>
````

### 15. Long code selection (fenced block with line count)

Trigger: >240 chars.

Input:

````json
{
  "kind": "code-selection",
  "marker": "code_1",
  "text": "export function helper0(input: number): number { return input * 0; }\nexport function helper1(input: number): number { return input * 1; }\nexport function helper2(input: number): number { return input * 2; }\nexport function helper3(input: number): number { return input * 3; }\nexport function helper4(input: number): number { return input * 4; }\nexport function helper5(input: number): number { return input * 5; }\nexport function helper6(input: number): number { return input * 6; }\nexport function helper7(input: number): number { return input * 7; }",
  "sourceLoc": "/repo/app/src/helpers.ts:1-8",
  "lines": 8
}
````

Rendered:

````text
[code selection at `src/helpers.ts:1-8` (8 lines)]:
```
export function helper0(input: number): number { return input * 0; }
export function helper1(input: number): number { return input * 1; }
export function helper2(input: number): number { return input * 2; }
export function helper3(input: number): number { return input * 3; }
export function helper4(input: number): number { return input * 4; }
export function helper5(input: number): number { return input * 5; }
export function helper6(input: number): number { return input * 6; }
export function helper7(input: number): number { return input * 7; }
```
````

### 16. Very long code selection (elided past 50 lines)

Trigger: >50 lines → first 50 + an elision count inside the fence.

Input:

````json
{
  "kind": "code-selection",
  "marker": "code_1",
  "text": "const row1 = compute(1);\nconst row2 = compute(2);\nconst row3 = compute(3);\nconst row4 = compute(4);\nconst row5 = compute(5);\nconst row6 = compute(6);\nconst row7 = compute(7);\nconst row8 = compute(8);\nconst row9 = compute(9);\nconst row10 = compute(10);\nconst row11 = compute(11);\nconst row12 = compute(12);\nconst row13 = compute(13);\nconst row14 = compute(14);\nconst row15 = compute(15);\nconst row16 = compute(16);\nconst row17 = compute(17);\nconst row18 = compute(18);\nconst row19 = compute(19);\nconst row20 = compute(20);\nconst row21 = compute(21);\nconst row22 = compute(22);\nconst row23 = compute(23);\nconst row24 = compute(24);\nconst row25 = compute(25);\nconst row26 = compute(26);\nconst row27 = compute(27);\nconst row28 = compute(28);\nconst row29 = compute(29);\nconst row30 = compute(30);\nconst row31 = compute(31);\nconst row32 = compute(32);\nconst row33 = compute(33);\nconst row34 = compute(34);\nconst row35 = compute(35);\nconst row36 = compute(36);\nconst row37 = compute(37);\nconst row38 = compute(38);\nconst row39 = compute(39);\nconst row40 = compute(40);\nconst row41 = compute(41);\nconst row42 = compute(42);\nconst row43 = compute(43);\nconst row44 = compute(44);\nconst row45 = compute(45);\nconst row46 = compute(46);\nconst row47 = compute(47);\nconst row48 = compute(48);\nconst row49 = compute(49);\nconst row50 = compute(50);\nconst row51 = compute(51);\nconst row52 = compute(52);\nconst row53 = compute(53);\nconst row54 = compute(54);\nconst row55 = compute(55);\nconst row56 = compute(56);\nconst row57 = compute(57);\nconst row58 = compute(58);\nconst row59 = compute(59);\nconst row60 = compute(60);",
  "sourceLoc": "/repo/app/src/table.ts:1-60",
  "lines": 60
}
````

Rendered:

````text
[code selection at `src/table.ts:1-60` (60 lines)]:
```
const row1 = compute(1);
const row2 = compute(2);
const row3 = compute(3);
const row4 = compute(4);
const row5 = compute(5);
const row6 = compute(6);
const row7 = compute(7);
const row8 = compute(8);
const row9 = compute(9);
const row10 = compute(10);
const row11 = compute(11);
const row12 = compute(12);
const row13 = compute(13);
const row14 = compute(14);
const row15 = compute(15);
const row16 = compute(16);
const row17 = compute(17);
const row18 = compute(18);
const row19 = compute(19);
const row20 = compute(20);
const row21 = compute(21);
const row22 = compute(22);
const row23 = compute(23);
const row24 = compute(24);
const row25 = compute(25);
const row26 = compute(26);
const row27 = compute(27);
const row28 = compute(28);
const row29 = compute(29);
const row30 = compute(30);
const row31 = compute(31);
const row32 = compute(32);
const row33 = compute(33);
const row34 = compute(34);
const row35 = compute(35);
const row36 = compute(36);
const row37 = compute(37);
const row38 = compute(38);
const row39 = compute(39);
const row40 = compute(40);
const row41 = compute(41);
const row42 = compute(42);
const row43 = compute(43);
const row44 = compute(44);
const row45 = compute(45);
const row46 = compute(46);
const row47 = compute(47);
const row48 = compute(48);
const row49 = compute(49);
const row50 = compute(50);
… (+10 more lines elided)
```
````

## D. App (on-screen) selections

Input schema (`ComposedItem`, `kind: "app-selection"`):

````ts
{
  kind: "app-selection";
  marker?: string;     // stream identity (sel_N)
  text: string;        // the selected page text
  sourceLoc?: string;  // data-source-loc of the selection's start element
  cell?: string;       // producing dataflow cell (data-cell)
  cellLoc?: string;    // that cell's definition site (file:line)
  tex?: string;        // TeX source when the selection is rendered mathematics
  url?: string;        // the page's location.href → <tab> record
}
````

### 17. Short app selection, no attribution

Input:

````json
{
  "kind": "app-selection",
  "marker": "sel_1",
  "text": "42.7"
}
````

Rendered:

````text
[selected text: "42.7"]
````

### 18. Short app selection, full attribution (metadata block with cell + tab)

Trigger: sourceLoc + cell + cellLoc + the page url.

Input:

````json
{
  "kind": "app-selection",
  "marker": "sel_1",
  "text": "42.7",
  "sourceLoc": "/repo/app/src/Readout.tsx:12:4",
  "cell": "meanValue",
  "cellLoc": "/repo/app/src/model.ts:33",
  "url": "http://localhost:5173/sim?run=3"
}
````

Rendered:

````text
[selected text: "42.7"]
<selection-metadata source="src/Readout.tsx:12:4">
  <cell name="meanValue" source="src/model.ts:33"/>
  <tab url="http://localhost:5173/sim?run=3"/>
</selection-metadata>
````

### 19. App selection of rendered mathematics (TeX attribution)

Input:

````json
{
  "kind": "app-selection",
  "marker": "sel_2",
  "text": "∂u/∂t = D ∂²u/∂x²",
  "sourceLoc": "/repo/app/src/Equation.tsx:8:2",
  "tex": "\\frac{\\partial u}{\\partial t} = D \\frac{\\partial^2 u}{\\partial x^2}"
}
````

Rendered:

````text
[selected text: "∂u/∂t = D ∂²u/∂x²"]
<selection-metadata source="src/Equation.tsx:8:2" tex="\frac{\partial u}{\partial t} = D \frac{\partial^2 u}{\partial x^2}"/>
````

### 20. Long app selection (fenced)

Trigger: >240 chars of page text.

Input:

````json
{
  "kind": "app-selection",
  "marker": "sel_1",
  "text": "The diffusion simulation shows temperature spreading through the rod over time. The diffusion simulation shows temperature spreading through the rod over time. The diffusion simulation shows temperature spreading through the rod over time. The diffusion simulation shows temperature spreading through the rod over time. ",
  "sourceLoc": "/repo/app/src/Explainer.tsx:3:1",
  "cell": "narrative"
}
````

Rendered:

````text
[selected text (1 line)]:
```
The diffusion simulation shows temperature spreading through the rod over time. The diffusion simulation shows temperature spreading through the rod over time. The diffusion simulation shows temperature spreading through the rod over time. The diffusion simulation shows temperature spreading through the rod over time.
```
<selection-metadata source="src/Explainer.tsx:3:1">
  <cell name="narrative"/>
</selection-metadata>
````

## E. Boundaries (the current-tab model)

Input schema (`ComposedItem`, `kind: "navigation" | "tab-switch"`, and the canonical `TabRecord`):

````ts
{
  kind: "navigation" | "tab-switch";  // same tab changing page vs a different tab
  from: string;      // location.href before the boundary
  to: string;        // location.href after
  fromTab?: number;  // tab-switch only: the driver's handle for the tab left
  toTab?: number;    // tab-switch only: the driver's handle for the tab entered
  tab?: TabRecord;   // the DESTINATION tab's full record, when the client gathered one
}

// TabRecord — ONE shape wherever a tab is described (preamble, boundaries,
// selection metadata); renders as <tab …/> with only the known fields:
{
  url: string;           // full location.href — the list_pages matching key
  title?: string;        // document.title
  aiui?: boolean;        // page carries aiui instrumentation → aiui-app="true"
  sourceRoot?: string;   // the app's source root, when aiui
  chromeTabId?: number; windowId?: number; tabIndex?: number;  // extension ids
  targetId?: string;     // CDP Target.TargetID → cdp-target-id
  driverTab?: number;    // the plain-page host's CDP driver handle
}
````

### 21. Navigation (same tab), URL only

The prior page needs no restating — the agent tracks the current tab.

Input:

````json
{
  "kind": "navigation",
  "from": "https://app.test/dashboard?tab=1",
  "to": "https://app.test/detail#sec"
}
````

Rendered:

````text
[current page changed: /detail#sec]
````

### 22. Navigation with a full destination tab record

Trigger: the event carried `tab` — as much debug/correlation info as the client had.

Input:

````json
{
  "kind": "navigation",
  "from": "https://app.test/dashboard?tab=1",
  "to": "http://localhost:5173/sim",
  "tab": {
    "url": "http://localhost:5173/sim",
    "title": "Spectra — dev",
    "aiui": true,
    "chromeTabId": 712,
    "windowId": 3,
    "targetId": "F00D"
  }
}
````

Rendered:

````text
[current page changed: <tab url="http://localhost:5173/sim" title="Spectra — dev" aiui-app="true" chrome-tab-id="712" window-id="3" cdp-target-id="F00D"/>]
````

### 23. Navigation with unparseable URLs

Trigger: strings `new URL` rejects → raw string; empty → `?`.

Input:

````json
{
  "kind": "navigation",
  "from": "not a url",
  "to": ""
}
````

Rendered:

````text
[current page changed: ?]
````

### 24. Tab switch (no full record — the driver handle still yields a minimal `<tab>`)

Trigger: `toTab` present, `tab` absent.

Input:

````json
{
  "kind": "tab-switch",
  "from": "https://app.test/a",
  "to": "https://docs.test/api/ref",
  "fromTab": 1,
  "toTab": 2
}
````

Rendered:

````text
[current tab changed: <tab url="https://docs.test/api/ref" driver-tab="2"/>]
````

## F. Corrections (note policy)

Input schema (a correction entry, alongside the transcript items):
````ts
{ original: string; instruction: string; applied: boolean }
// policy "note" + applied: false → appended parenthetical
````

### 25. Unapplied correction under `policy: "note"`

Trigger: a correction the patcher could not apply → appended parenthetical.

Input:

````json
{
  "items": [
    {
      "kind": "text",
      "text": "make the plot tall her"
    }
  ],
  "corrections": [
    {
      "original": "tall her",
      "instruction": "taller",
      "applied": false
    }
  ]
}
````

Rendered:

````text
make the plot tall her (transcription fix: "tall her" → taller)
````

## G. A full interleaved turn (joins, trims, blank-line separation)

### 26. Transcript runs · rich shot · selection · navigation · viewport shot

The `kind: "text"` items are TRANSCRIPT RUNS (the user's spoken words) — this case audits the seams between them and the blocks: inline runs join with a single space, every multi-line block is set off by one blank line (no stray leading/lone spaces at the seams), leading/trailing trim.

Input:

````json
[
  {
    "kind": "text",
    "text": "make this legend"
  },
  {
    "kind": "shot",
    "marker": "shot_1",
    "path": "/repo/app/.aiui-cache/traces/t1/shot_1.png",
    "components": [
      {
        "component": "Legend",
        "source": "/repo/app/src/Legend.tsx:30:2",
        "cells": [
          {
            "name": "colorScale"
          }
        ]
      }
    ]
  },
  {
    "kind": "text",
    "text": "wider, and align it with"
  },
  {
    "kind": "app-selection",
    "marker": "sel_1",
    "text": "Mean: 42.7",
    "sourceLoc": "/repo/app/src/Readout.tsx:12:4"
  },
  {
    "kind": "navigation",
    "from": "https://app.test/a",
    "to": "https://app.test/b"
  },
  {
    "kind": "text",
    "text": "then check the whole page"
  },
  {
    "kind": "shot",
    "marker": "shot_2",
    "path": "/repo/app/.aiui-cache/traces/t1/shot_2.png",
    "viewport": true
  }
]
````

Rendered:

````text
make this legend

[screenshot located at .aiui-cache/traces/t1/shot_1.png]
<screenshot-metadata path=".aiui-cache/traces/t1/shot_1.png">
  <element name="Legend" source="src/Legend.tsx:30:2">
    <cell name="colorScale"/>
  </element>
</screenshot-metadata>

wider, and align it with

[selected text: "Mean: 42.7"]
<selection-metadata source="src/Readout.tsx:12:4"/>

[current page changed: /b] then check the whole page [screenshot located at .aiui-cache/traces/t1/shot_2.png (full viewport)]
````

## H. The context preamble (channel, `prompt-context.ts`)

Input schema (the hello's `TabInfo` + `SourceInfo`, fixed at connect time; the body is the composed prompt from sections A–G). A present `source.root` is the INTERIM aiui-app detection signal: it gates the “web app under development” framing, the `aiui-app` tab attribute, and the relative-paths line. The transcription note is TURN-dependent — `intent-v1` appends it at fin only when the stream contains speech-transcribed text:
````ts
{
  tab?: { url?: string; title?: string; chromeTabId?: number;
          windowId?: number; tabIndex?: number; targetId?: string };  // CDP Target.TargetID
  source?: { root?: string };  // the dev server's absolute source root
}
````

### 27. Full hello (aiui app detected: every tab hint + source root) — the wrapped prompt

The body starts right after the `---` rule. (`preambleLen` = 311.)

Input:

````json
{
  "tab": {
    "title": "Spectra — dev",
    "url": "http://localhost:5173/",
    "chromeTabId": 712,
    "windowId": 3,
    "tabIndex": 0,
    "targetId": "F00D"
  },
  "source": {
    "root": "/repo/app"
  }
}
````

Rendered:

````text
This prompt was sent from the aiui intent tool attached to a web app under development.

[current tab: <tab url="http://localhost:5173/" title="Spectra — dev" aiui-app="true" chrome-tab-id="712" window-id="3" tab-index="0" cdp-target-id="F00D"/>]

Relative paths in this prompt are relative to: /repo/app

---

make this wider
````

### 28. Minimal hello (title+url only, NO aiui app): the neutral opening, no dev framing

Input:

````json
{
  "tab": {
    "title": "App",
    "url": "http://localhost:5173/"
  }
}
````

Rendered:

````text
This prompt was sent from the aiui intent tool.

[current tab: <tab url="http://localhost:5173/" title="App"/>]

---

make this wider
````

### 29. A SPEECH turn (aiui hello + transcription note appended at fin)

Input shows the hello; the note is turn-dependent, not hello-fixed. (`preambleLen` = 389.)

Input:

````json
{
  "tab": {
    "title": "Spectra — dev",
    "url": "http://localhost:5173/",
    "chromeTabId": 712,
    "windowId": 3,
    "tabIndex": 0,
    "targetId": "F00D"
  },
  "source": {
    "root": "/repo/app"
  }
}
````

Rendered:

````text
This prompt was sent from the aiui intent tool attached to a web app under development.

[current tab: <tab url="http://localhost:5173/" title="Spectra — dev" aiui-app="true" chrome-tab-id="712" window-id="3" tab-index="0" cdp-target-id="F00D"/>]

Relative paths in this prompt are relative to: /repo/app

Portions of the prompt were transcribed and might have transcription errors.

---

make this wider
````

### 30. LEGACY selection section — text-concat (text modality) ONLY; retired from intent-v1

intent-v1 now IGNORES the legacy context chunk entirely; this wording survives only for `text-concat`'s submit-time selection. (`preambleLen` = 245.)

Input:

````json
{
  "text": "Mean: 42.7",
  "sourceLoc": "/repo/app/src/Readout.tsx:12:4",
  "cell": "meanValue",
  "cellLoc": "/repo/app/src/model.ts:33",
  "tex": "\\bar{x} = 42.7"
}
````

Rendered:

````text
It concerns this on-screen selection: "Mean: 42.7" (authored at /repo/app/src/Readout.tsx:12:4; produced by cell meanValue defined at /repo/app/src/model.ts:33).
The selected content is rendered mathematics; its TeX source: \bar{x} = 42.7

---

explain this
````

### 31. Bare client (no hello context): body passes through unwrapped

Input:

````json
{}
````

Rendered:

````text
just the body
````

## I. The MCP server's self-description (static strings, quoted verbatim)

### 32. Server `instructions` (server.ts) — the once-per-session lesson: the channel + the prompt vocabulary

Imported from the source, so this quote can never drift. The correlation workflow lives HERE (taught once), not in every turn's preamble.

````text
This is the aiui channel, a one-way event feed into your session. Events arrive as `<channel source="aiui" ...>` blocks: read them and act on them as context. The channel itself is one-way — there is nothing to reply to and no tool to call back into it (this server's tools stand alone).

Prompts lowered by the aiui intent tool embed a small vocabulary you should know. Plain-text bracket markers carry the user's captured context inline, at the position it happened in their turn: `[screenshot located at <path>]` (a captured image saved at <path> — read it with your image tools; `[pasted image located at …]` is CLIPBOARD content, not what was on screen; `MISSING` means the pixels were never captured), `[selected text: "…"]` (an on-screen selection), `[code selection at `<loc>`: `<code>`]` (contributed code; long selections fence below a `(N lines)` header, elided past 50 lines), and `[current page changed: <tab …/>]` / `[current tab changed: <tab …/>]` (the user navigated the same tab, or turned to a different tab, mid-turn — the destination's `<tab>` record rides inline in the marker, and text ABOVE it refers to the previous page).

XML sidecar blocks carry machine-readable metadata about the marker they follow. `<screenshot-metadata>` lists the UI elements a capture framed: `<element name source>` children with nested `<cell name source/>` cells. `<selection-metadata>` carries a selection's provenance: `source` (where it was authored), `tex` (TeX source of selected mathematics), and `<cell>` / `<tab>` children. Cells are dataflow nodes of the aiui framework — they only exist on pages marked as aiui apps; on other pages expect no element/cell metadata at all.

`<tab …/>` is the canonical browser-tab record, used everywhere a tab is described: the `[current tab: <tab …/>]` preamble marker (the tab the turn was sent from), the `[current page/tab changed: <tab …/>]` boundary markers, and `<selection-metadata>`. Attributes, all optional except url: `url`, `title`, `aiui-app="true"` (the page carries aiui instrumentation), `source-root` (the app's source directory), `chrome-tab-id`, `window-id`, `tab-index`, `cdp-target-id`, `driver-tab`. To act on a tab with the Chrome DevTools MCP: every id is a correlation HINT only — none is the DevTools MCP's own pageId. Call list_pages, match by url/title, select_page with the pageId it returned, and verify you selected the right page. The session-browser skill covers this workflow.
````

### 33. The prompt's delivery envelope (commands/mcp.ts:124)

Every lowered prompt reaches the session as an MCP notification; Claude Code renders it as the `<channel>` block the instructions describe. The channel controls `content` and `meta`; the block's final wording is Claude Code's.

````text
method: "notifications/claude/channel"
params: { content: <the wrapped prompt>, meta: { kind: "prompt", ...optionC attachment paths } }
````

### 34. Tool: `channel_info` (tools.ts:130)

````text
Return this aiui channel's own info: its tag, pid, ppid, port, cwd, and the Claude Code session it's attached to (name, sessionId, status). Returns a JSON object.
````

### 35. Tool: `page_tools_list` (tools.ts:72)

````text
List the tools that live in the connected browser page(s) under development (registered by the page's aiui instrumentation). Returns a JSON array of directory entries: clientId, ns (page namespace), url, tab, and each tool's name/description/inputSchema. Entries from the browser's active tab sort first and carry activeTab: true (when a client reports tab activation; otherwise the flag is simply absent). Call this FIRST to discover what's available, then invoke one with page_tools_call. The list is empty when no dev page is connected.
````

### 36. Tool: `page_tools_call` (tools.ts:81)

````text
Invoke one of the browser page's tools (discover them with page_tools_list first) and return its JSON result. Args: { name (required), args? (must match that tool's inputSchema), ns? and clientId? to disambiguate }. When exactly one registered tool has the given name you may omit ns/clientId; if several pages expose the same name, the one on the browser's active tab wins — when that still doesn't single one out the call errors and lists the candidates (pass ns and/or clientId to pick one). Errors if no page is connected, no tool matches, the page is mid-reload, or the call times out.
````

### 37. Tool: `channel_reload` (tools.ts:90)

````text
After you edit this channel's own source, reload its lowering layer in place — the format registry is rebuilt from the code now on disk, no session restart. Live websockets drop and reconnect on their own (an in-flight intent turn is abandoned; the page stays up), and the MCP stdio session and web port are unaffected. Returns { reloaded, generation, socketsDropped }. Only reloads the format-entry modules (processors, intent-v1) and their edits; changes deeper in the import graph still need a full relaunch.
````
