/**
 * mermaid-theme.ts — the design system's tokens as Mermaid's `themeVariables`,
 * for every diagram on the catalog page. Mermaid's stylesheet is id-scoped, so
 * the palette goes IN through the config; `look: "classic"` keeps the shapes
 * flat. A copy of the aiui-viz lab's theme (lab/src/ui/mermaid-theme.ts) —
 * the second page wanting it, which is the catalog's own rule for promoting
 * it into aiui-design (see the page's findings).
 */
import { FONTS, TOKENS } from "@habemus-papadum/aiui-design";
import type { MermaidConfig } from "mermaid";

export const CATALOG_MERMAID: MermaidConfig = {
  theme: "base",
  look: "classic",
  layout: "dagre",
  fontFamily: FONTS.sans,
  themeVariables: {
    fontFamily: FONTS.sans,
    fontSize: "13px",
    primaryColor: TOKENS.surfaceRaised,
    primaryBorderColor: TOKENS.hairline,
    primaryTextColor: TOKENS.ink,
    secondaryColor: TOKENS.surface,
    secondaryBorderColor: TOKENS.ghost,
    secondaryTextColor: TOKENS.ink,
    tertiaryColor: TOKENS.surface,
    tertiaryBorderColor: TOKENS.ghost,
    tertiaryTextColor: TOKENS.ink,
    lineColor: TOKENS.inkMuted,
    textColor: TOKENS.ink,
    mainBkg: TOKENS.surfaceRaised,
    nodeBorder: TOKENS.hairline,
    clusterBkg: TOKENS.surface,
    clusterBorder: TOKENS.ghost,
    titleColor: TOKENS.inkMuted,
    edgeLabelBackground: TOKENS.surface,
  },
  flowchart: {
    curve: "basis",
    padding: 8,
    nodeSpacing: 28,
    rankSpacing: 40,
    // Mermaid 12.2 defaults this to 120px and sets plain labels nowrap inside
    // it, so any label wider than 120px is clipped (the catalog's shelf names
    // are). A node grows to its label up to this width.
    wrappingWidth: 480,
  },
};
