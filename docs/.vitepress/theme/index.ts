import DefaultTheme from "vitepress/theme";
import "./custom.css";

// Default VitePress theme, plus custom.css — which only constrains how the
// vitepress-plugin-mermaid <Mermaid> SVGs lay out (centered, never wider than the
// content column, horizontal-scroll if a diagram genuinely overflows). No app logic.
export default DefaultTheme;
