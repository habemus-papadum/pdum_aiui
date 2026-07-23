/**
 * card.tsx — this app's **landing card** (see aiui-viz's `DemoCard`) for a
 * multi-app shell like a gallery of demos: a blurb and a LIVE preview mini-app.
 *
 * The preview must be self-contained and cheap: a shell mounts every app's
 * preview at once, so it must NOT import this app's `store`/`graph` (their
 * durable graph is heavy). Build it from your pure model only — the starter's
 * `RosePreview` draws straight from `model/rose.ts`. After a reset the scenery
 * is gone and the card falls back to `Placeholder` (the app's name in a box);
 * replace it with your own small live view.
 */
import type { DemoCard } from "@habemus-papadum/aiui-viz";
import type { Component } from "solid-js";

/** The app slug (the aiui compiler leaves this token for `create-aiui` to fill;
 * a shell shows it when this app has no live preview yet). */
const NAME = "holograms";

const Placeholder: Component = () => <div class="demo-card-placeholder">{NAME}</div>;

export const card: DemoCard = {
  blurb: "An aiui starter app — describe what you want and build it in the loop.",
  Preview: Placeholder,
};
