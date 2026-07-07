# @habemus-papadum/aiui-ink

A reusable, framework-free canvas **ink surface**. It turns local pointer drags into strokes and
accepts strokes fed in from elsewhere (a remote pen), each with its own color and width, with
optional fade and screenshot compositing. The pure geometry (bounds, smoothing, fade, pressure) is
split into `./strokes` so it can be unit-tested and reused off the DOM.

Graduated from the aiui dev-overlay's internal ink layer, and used by
[`@habemus-papadum/aiui-paint`](../aiui-paint) to land an iPad's pen on a desktop browser.

## Install

```sh
npm install @habemus-papadum/aiui-ink
```

## Usage

```ts
import { InkSurface } from "@habemus-papadum/aiui-ink";

const surface = new InkSurface({
  color: () => "#4cc9f0",   // brush for LOCAL strokes
  width: () => 6,
  fadeSec: () => 0,          // 0 persists; > 0 makes strokes evaporate
  onStrokeEnd: (s) => console.log("drew", s.points.length, "points"),
});
surface.setActive(true);     // receive pointer events

// Feed a stroke from anywhere (points in the surface's CSS pixels):
surface.remoteBegin("s1", { style: { color: "#f00", width: 4 }, point: { x: 20, y: 20 } });
surface.remotePoint("s1", { x: 80, y: 60 });
surface.remoteEnd("s1", { x: 140, y: 20 });

// Composite current ink into another 2D context (e.g. a screenshot):
surface.compositeInto(ctx, offsetX, offsetY, scale);
```

Coordinates are the surface's own CSS pixels; it is deliberately unaware of any wire protocol's
normalized space. A caller streaming strokes between two surfaces maps `norm ↔ px` at the boundary
using `surface.size()`.

See the [iPad Paint Stream guide](../../docs/guide/paint-stream.md) for the streaming use case.
