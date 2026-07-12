import aiuiDevOverlay from "@habemus-papadum/aiui-dev-overlay/vite";
import { webextConfig } from "@habemus-papadum/aiui-webext/vite";
import manifest from "./manifest.config";

// Dev port 5317 — pinned & strict (see the kit's vite.ts for why a squatted
// port must fail loudly and what `dist/` means in dev vs build mode).
//
// aiuiDevOverlay here is the aiui COMPILER only (`mount: false` — the panel
// IS the intent tool; nothing overlays it): `locator` injects control()/cell()
// names + locations and stamps JSX source locs, which the panel's model layer
// (src/panel/model/) requires. It must run before the Solid transform —
// webextConfig's prePlugins slot exists for exactly this.
export default webextConfig({
  manifest,
  devPort: 5317,
  prePlugins: [aiuiDevOverlay({ locator: true, mount: false })],
});
