/**
 * page.tsx — circle as a shell page: the cell graph + agent tools build on
 * first import, the App is the mounted view. `deactivate` disarms the Zen
 * centre-ghost when the route leaves (its rAF island otherwise keeps sampling);
 * the durable pencil surface and cells survive for the return visit
 * (pause-not-destroy), and the surface's own rAF is idle-cheap when still.
 */
import "./page.css";
import "./model/graph"; // builds the cell graph + registers window.__circle
import type { GalleryPage } from "../../site/pages";
import { centerGhost } from "./model/store";
import { App } from "./ui/App";

export const page: GalleryPage = {
  title: "circle — aiui demo app",
  App,
  deactivate: () => centerGhost.disarm(),
};
