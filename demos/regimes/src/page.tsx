/**
 * page.tsx — this app as a mountable **SitePage**: the one entry both hosts
 * share. `main.tsx` mounts it standalone; the gallery shell discovers it via
 * the `aiui.sitePage` marker in package.json and this package's `./page`
 * export. Importing this module IS the app's wiring: the graph import builds
 * the cell graph and registers the agent tools; the page stylesheet rides
 * along. Everything on the page is event-driven (no rAF loops), so there is
 * nothing durable to park — no activate/deactivate.
 */
import "./page.css";
import "./model/graph"; // builds the cell graph + registers the agent tools
import type { SitePage } from "@habemus-papadum/aiui-viz";
import { appScope } from "./model/store";
import { App } from "./ui/App";

export const page: SitePage = {
  title: "regimes — which error owns your loss?",
  App,
  toolsNs: appScope.name,
};
