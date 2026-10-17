/**
 * page.tsx — the styleguide as a mountable SitePage: the design system's
 * reference sheet, exhibited through the real aiui-viz components over the
 * tiny control surface in model/. The stylesheet imported here is only the
 * sheet's own chrome; the look is the design package's, imported once by the
 * host (main.tsx standalone, the gallery shell otherwise).
 */
import "./styles.css";
import "./model/graph"; // builds the cell graph + registers the agent tools
import { mermaidTheme } from "@habemus-papadum/aiui-design";
import type { SitePage } from "@habemus-papadum/aiui-viz";
import { configureMermaid } from "@habemus-papadum/aiui-viz/site/mermaid";
import { appScope } from "./model/store";
import { App } from "./ui/App";

// The design system's own Mermaid theme, once, for the diagram on the sheet.
configureMermaid(mermaidTheme());

export const page: SitePage = {
  title: "styleguide — the aiui design system",
  App,
  toolsNs: appScope.name,
};
