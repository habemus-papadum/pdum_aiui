import "@habemus-papadum/aiui-design/site.css";
import { PageBoundary, setSitePageActive } from "@habemus-papadum/aiui-viz";
import { render } from "@solidjs/web";
import { page } from "./page";

document.title = page.title;
setSitePageActive(page, true);
render(
  () => (
    <PageBoundary name={page.title}>
      <page.App />
    </PageBoundary>
  ),
  document.getElementById("root") as HTMLElement,
);
