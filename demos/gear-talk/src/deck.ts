/**
 * deck.ts — the deck assembled: slides as DATA + the deck model (which
 * declares `gear-talk/slide` and the next/prev verbs under the SAME scope as
 * the talk's content controls, so one toolkit serves narration and content).
 *
 * Import order note: ./model/graph registers the standard tools; the deck
 * model only declares more controls/actions into the same surface, and the
 * kit's control-surface subscription picks them up regardless of order.
 */
import { createDeckModel, type SlideDef } from "@habemus-papadum/aiui-slides";
import { talkScope } from "./model/store";
import {
  AnatomyPreview,
  ColophonPreview,
  DesignPreview,
  InvolutePreview,
  MeshPreview,
  TitlePreview,
} from "./slides/previews";
import {
  AnatomySlide,
  ColophonSlide,
  DesignSlide,
  InvoluteSlide,
  MeshSlide,
  TitleSlide,
} from "./slides/slides";

export const SLIDES: SlideDef[] = [
  { id: "title", title: "The Involute Gear", content: TitleSlide, preview: TitlePreview },
  { id: "involute", title: "Why the involute?", content: InvoluteSlide, preview: InvolutePreview },
  { id: "anatomy", title: "Anatomy of a tooth", content: AnatomySlide, preview: AnatomyPreview },
  { id: "mesh", title: "The mesh, in motion", content: MeshSlide, preview: MeshPreview },
  { id: "design", title: "Designing a pair", content: DesignSlide, preview: DesignPreview },
  { id: "colophon", title: "fin", content: ColophonSlide, preview: ColophonPreview },
];

export const deck = createDeckModel(talkScope, SLIDES);
