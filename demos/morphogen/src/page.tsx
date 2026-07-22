/**
 * page.tsx — morphogen as a mountable SitePage: the cell graph + agent tools
 * build on first import, the App is the mounted view, and the sim loop is
 * parked while off-route (the GPU engine, its accrued field, the worker, and
 * the history ring are durable — they survive the route exactly as they
 * survive an HMR swap). Mounted by the gallery shell (which discovers it via
 * this package's `aiui.sitePage` marker) and by ./main.tsx standalone.
 */
import "./page.css";
import "./model/graph"; // builds the cell graph + registers window.__morphogen
import type { SitePage } from "@habemus-papadum/aiui-viz";
import { sim } from "./model/store";
import { App } from "./ui/App";

export const page: SitePage = {
  title: "morphogen — aiui demo app",
  App,
  activate: () => sim.loop.resume(),
  deactivate: () => sim.loop.pause(),
};
