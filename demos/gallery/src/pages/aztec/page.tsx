/**
 * page.tsx — aztec as a shell page: graph + tools on first import, the App as
 * the mounted view, and the playback rAF parked while off-route. The shuffle
 * WORKER is deliberately not paused: a mid-run growth keeps streaming frames
 * into the durable ring (event-driven work costs nothing when idle), so you
 * come back to a further-grown tiling — the pause-not-destroy contract.
 */
import "./page.css";
import "./graph"; // builds the cell graph + registers window.__aztec
import type { GalleryPage } from "../../site/pages";
import { player } from "./store";
import { App } from "./ui/App";

export const page: GalleryPage = {
  title: "aztec — aiui demo app",
  App,
  activate: () => player.resume(),
  deactivate: () => player.pause(),
};
