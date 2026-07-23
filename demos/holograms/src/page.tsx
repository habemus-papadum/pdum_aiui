/**
 * page.tsx — holograms as a mountable SitePage: importing this builds the
 * cell graph and registers window.__holograms (side effects); the App is the
 * view. FieldMap islands park their own rAF loops when off screen or
 * unmounted — nothing durable to activate/deactivate. Mounted by the gallery
 * shell (via the `aiui.sitePage` marker) and by ./main.tsx standalone.
 */
import "@habemus-papadum/aiui-optics/widgets.css";
import "./page.css";
import "./model/graph"; // builds the cell graph + registers the agent tools
import type { SitePage } from "@habemus-papadum/aiui-viz";
import { App } from "./ui/App";

export const page: SitePage = {
  title: "holograms — the film that remembers light",
  App,
};
