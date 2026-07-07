# Getting Started with @habemus-papadum/aiui-ink

A framework-free canvas **ink surface**: local pointer inking or a remote stroke feed, with
per-stroke color and thickness, optional fade, and screenshot compositing.

## Install

```sh
npm install @habemus-papadum/aiui-ink
```

## Draw locally

```ts
import { InkSurface } from "@habemus-papadum/aiui-ink";

const surface = new InkSurface({
  color: () => "#4cc9f0",  // brush for local strokes
  width: () => 6,
  fadeSec: () => 0,         // 0 persists; > 0 fades strokes over that many seconds
});
surface.setActive(true);    // start receiving pointer events
```

## Feed a remote stroke

Points are in the surface's own CSS pixels — map from any normalized wire coordinates against
`surface.size()` first.

```ts
surface.remoteBegin("s1", { style: { color: "#f00", width: 4 }, point: { x: 20, y: 20 } });
surface.remotePoint("s1", { x: 80, y: 60 });
surface.remoteEnd("s1", { x: 140, y: 20 });
```

## Composite into a screenshot

```ts
surface.compositeInto(ctx, offsetX, offsetY, scale); // annotations travel with the pixels
```

The pure geometry — bounds, midpoint smoothing, fade alpha, pressure→width — lives in `./strokes`
and is unit-testable without a DOM. For the streaming use case (an iPad drawing on a desktop
browser), see the [iPad Paint Stream guide](/guide/paint-stream) and
[`@habemus-papadum/aiui-paint`](/packages/aiui-paint/).
