/**
 * main.tsx — the STANDALONE entry: this demo run as its own app (`pnpm dev`
 * here, the full aiui loop alongside `pnpm claude`). Everything real lives
 * behind ./page; the only standalone-specific work is the shared journal
 * chrome the gallery shell would otherwise provide.
 */
import "@habemus-papadum/aiui-journal/styles.css";
import { initTheme } from "@habemus-papadum/aiui-journal";
import { render } from "@solidjs/web";
import { page } from "./page";

initTheme(); // re-assert the head's pre-paint data-theme="dark"
document.title = page.title;
page.activate?.();
render(() => <page.App />, document.getElementById("root") as HTMLElement);
