import "./styles.css";
import type { SitePage } from "@habemus-papadum/aiui-viz";
import "./model/graph";
import { appScope } from "./model/store";
import { App } from "./ui/App";

export const page: SitePage = {
  title: "Semantic SVG · interaction labs",
  App,
  toolsNs: appScope.name,
};
