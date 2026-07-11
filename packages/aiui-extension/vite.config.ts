import { webextConfig } from "@habemus-papadum/aiui-webext/vite";
import manifest from "./manifest.config";

// Dev port 5317 — pinned & strict (see the kit's vite.ts for why a squatted
// port must fail loudly and what `dist/` means in dev vs build mode).
export default webextConfig({ manifest, devPort: 5317 });
