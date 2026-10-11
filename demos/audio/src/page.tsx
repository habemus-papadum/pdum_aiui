import "./styles.css";
import "./model/graph"; // builds the cell graph + registers the agent tools
import type { SitePage } from "@habemus-papadum/aiui-viz";
import { appScope, current } from "./model/store";
import { App } from "./ui/App";

export const page: SitePage = {
  title: "Audio",
  deactivate() {
    const hub = current.get()?.hub;
    if (["dictation", "editor"].includes(hub?.snapshot().selectedInput ?? ""))
      void hub?.parkInput();
  },
  App,
  toolsNs: appScope.name,
};
