/**
 * page.tsx — circle as a mountable SitePage: the cell graph + agent tools
 * build on first import, the App is the mounted view. `deactivate` disarms the
 * Zen centre-ghost when the route leaves (its rAF island otherwise keeps
 * sampling); the durable pencil surface and cells survive for the return visit
 * (pause-not-destroy), and the surface's own rAF is idle-cheap when still.
 * Mounted by the gallery shell (discovered via this package's `aiui.sitePage`
 * marker) and by ./main.tsx standalone.
 */
import "./page.css";
import "./model/graph"; // builds the cell graph + registers window.__circle
import type { SitePage } from "@habemus-papadum/aiui-viz";
import { centerGhost } from "./model/store";
import { App } from "./ui/App";

export const page: SitePage = {
  title: "circle — aiui demo app",
  App,
  deactivate: () => centerGhost.disarm(),
};
