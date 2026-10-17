/**
 * page.tsx — the catalog as a mountable SitePage. Importing this module is
 * the wiring: the graph import builds the cells and registers the agent
 * tools, the stylesheet rides along, and Mermaid takes the design system's
 * palette once for every diagram on the page. The lifecycle hooks only count
 * — the page runs no continuous work — but the counts are what the `durable`
 * and `the page` specimens show: leave for another notebook and come back,
 * and the numbers prove the roots outlived the route.
 */
import "./styles.css";
import "./model/graph"; // builds the cell graph + registers the agent tools
import { mermaidTheme } from "@habemus-papadum/aiui-design";
import type { SitePage } from "@habemus-papadum/aiui-viz";
import { configureMermaid } from "@habemus-papadum/aiui-viz/site/mermaid";
import { activations, appScope, deactivations, PAGE_TITLE } from "./model/store";
import { App } from "./ui/App";

configureMermaid(mermaidTheme());

export const page: SitePage = {
  title: PAGE_TITLE,
  App,
  toolsNs: appScope.name,
  activate: () => activations.set((n) => n + 1),
  deactivate: () => deactivations.set((n) => n + 1),
};
