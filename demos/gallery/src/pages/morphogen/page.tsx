/**
 * page.tsx — morphogen as a shell page: graph + tools on first import, the
 * App as the mounted view, and the sim loop parked while off-route (the GPU
 * engine, its accrued field, the worker, and the history ring are durable —
 * they survive the route exactly as they survive an HMR swap).
 */
import "../../model/graph"; // builds the cell graph + registers window.__morpho
import { sim } from "../../model/store";
import type { GalleryPage } from "../../site/pages";
import { App } from "../../ui/App";

export const page: GalleryPage = {
  title: "morphogen — aiui demo app",
  App,
  activate: () => sim.loop.resume(),
  deactivate: () => sim.loop.pause(),
};
