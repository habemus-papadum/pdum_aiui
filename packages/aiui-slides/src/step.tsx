/**
 * step.tsx — the additive scene idiom, canned: `<Step at={k}>` wraps content
 * that ENTERS at scene k of its slide and stays (scenes build on each other;
 * types.ts documents the convention). It renders a plain div whose `is-in`
 * class tracks `useSlide().step() >= at`, and the default stylesheet gives
 * that flip a small rise-and-fade transition — reversible for free, so
 * backing up un-plays the scene, and disabled wholesale under
 * `prefers-reduced-motion`.
 *
 * This is a convenience, not the mechanism: a slide needing anything richer
 * (non-additive switches, choreographed SVG, staggered children) reads
 * `useSlide().step()` itself and styles its own classes — the deck only
 * promises what the step IS, never how a slide draws it.
 */
import type { JSX } from "@solidjs/web";
import { useSlide } from "./deck-context";

export function Step(props: { at: number; class?: string; children: JSX.Element }): JSX.Element {
  const slide = useSlide();
  const cls = (): string =>
    `aiui-step${slide.step() >= props.at ? " is-in" : ""}${
      props.class === undefined ? "" : ` ${props.class}`
    }`;
  return <div class={cls()}>{props.children}</div>;
}
