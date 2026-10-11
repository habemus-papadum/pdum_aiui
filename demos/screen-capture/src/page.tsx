import "./styles.css";
import "./model/graph";
import type { SitePage } from "@habemus-papadum/aiui-viz";
import { appScope, capture } from "./model/store";
import { App } from "./ui/App";
export const page: SitePage = {
  title: "Screen capture",
  App,
  toolsNs: appScope.name,
  deactivate: () => capture.stop(),
};
