/**
 * mermaid-theme.ts — the design system's tokens as Mermaid's `themeVariables`.
 * Mermaid's stylesheet is id-scoped (`#svgId .node rect {…}`), which beats any
 * class rule a page writes, so the palette has to go IN through the config:
 * the base theme with the literal twins of tokens.css (the same reason the
 * design package exports them for canvases and Plot). `look: "classic"` keeps
 * the shapes flat (the default `neo` look draws gradient borders);
 * `layout: "dagre"` is the lighter of the two bundled layouts.
 */
import { FONTS, TOKENS } from "@habemus-papadum/aiui-design";
import type { MermaidConfig } from "mermaid";

export const LAB_MERMAID: MermaidConfig = {
  theme: "base",
  look: "classic",
  layout: "dagre",
  fontFamily: FONTS.sans,
  themeVariables: {
    fontFamily: FONTS.sans,
    fontSize: "14px",
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
    noteBkgColor: TOKENS.surfaceRaised,
    noteBorderColor: TOKENS.ghost,
    noteTextColor: TOKENS.ink,
    actorBkg: TOKENS.surfaceRaised,
    actorBorder: TOKENS.hairline,
    actorTextColor: TOKENS.ink,
    actorLineColor: TOKENS.ghost,
    signalColor: TOKENS.inkMuted,
    signalTextColor: TOKENS.ink,
    labelBoxBkgColor: TOKENS.surface,
    labelBoxBorderColor: TOKENS.ghost,
  },
  flowchart: {
    curve: "basis",
    padding: 10,
    nodeSpacing: 32,
    rankSpacing: 44,
  },
};
