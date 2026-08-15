/**
 * page.tsx — the talk as a mountable SitePage: importing ./model/graph builds
 * the cell graph + registers the toolkit, ./deck declares the slide control,
 * and the App is aiui-slides' Deck over the assembled model. The slide URLs
 * ride the pathname tail (deckBase sniffs the mount point at runtime — the
 * same page works at "/" standalone, "/gear-talk" in the gallery, and
 * "/aiui/gear-talk" published). Nothing durable to park beyond what the
 * slides park themselves (their rAF islands gate on `useSlide().active`), so
 * no activate/deactivate.
 */
import "@habemus-papadum/aiui-slides/styles.css";
import "./page.css";
import "./model/graph"; // builds the cell graph + registers window.__gear_talk
import { Deck, deckBase } from "@habemus-papadum/aiui-slides";
import type { SitePage } from "@habemus-papadum/aiui-viz";
import { deck } from "./deck";

function App() {
  return <Deck model={deck} basePath={deckBase("gear-talk")} class="gear-talk" />;
}

export const page: SitePage = {
  title: "the involute gear — an aiui talk",
  App,
  toolsNs: "gear-talk",
};
