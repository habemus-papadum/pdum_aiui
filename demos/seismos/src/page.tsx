/**
 * page.tsx — seismos as a mountable SitePage. No activate/deactivate:
 * everything here is event-driven (DuckDB runs queries when a Selection
 * changes, and nothing changes selections on a hidden page), so an off-route
 * seismos costs nothing by construction — the loaded table stays warm in the
 * durable store for the next visit. Mounted by the gallery shell (discovered
 * via this package's `aiui.sitePage` marker) and by ./main.tsx standalone.
 */
import "./page.css";
import "./graph"; // builds the cell graph + registers window.__seismos
import type { SitePage } from "@habemus-papadum/aiui-viz";
import { App } from "./ui/App";

export const page: SitePage = {
  title: "seismos — aiui demo app",
  App,
};
