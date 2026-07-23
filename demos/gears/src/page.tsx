/**
 * page.tsx — gears as a mountable SitePage: the cell graph + agent tools build
 * on first import, the App is the mounted view. Everything is event-driven
 * (the mesh animation's rAF island lives inside GearMesh and self-manages via
 * onCleanup when the component unmounts), so there is nothing durable to park —
 * no activate/deactivate. Mounted by the gallery shell (discovered via this
 * package's `aiui.sitePage` marker) and by ./main.tsx standalone.
 */
import "./page.css";
import "./model/graph"; // builds the cell graph + registers window.__gears
import type { SitePage } from "@habemus-papadum/aiui-viz";
import { App } from "./ui/App";

export const page: SitePage = {
  title: "gears — aiui demo app",
  App,
};
