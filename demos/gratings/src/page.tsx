/**
 * page.tsx — gratings as a mountable SitePage: importing this builds the cell
 * graph and registers window.__gratings (side effects); the App is the view.
 * The FieldMap islands park their own rAF loops when scrolled away or
 * unmounted, so there is nothing durable to activate/deactivate. Mounted by
 * the gallery shell (via this package's `aiui.sitePage` marker) and by
 * ./main.tsx standalone.
 */
import "@habemus-papadum/aiui-optics/widgets.css";
import "./page.css";
import "./model/graph"; // builds the cell graph + registers the agent tools
import type { SitePage } from "@habemus-papadum/aiui-viz";
import { App } from "./ui/App";

export const page: SitePage = {
  title: "gratings — steering light with stripes",
  App,
};
