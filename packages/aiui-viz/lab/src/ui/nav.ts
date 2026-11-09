import type { SiteNavItem } from "@habemus-papadum/aiui-viz/site";
import { PAGES } from "./routes";

/** "/" under `pnpm lab`, "/aiui/lab/" on the published site. */
export const BASE = import.meta.env.BASE_URL;

export const NAV: readonly SiteNavItem[] = PAGES.map((p) => ({ ...p, href: `${BASE}${p.id}` }));
