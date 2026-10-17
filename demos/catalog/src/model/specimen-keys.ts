/**
 * specimen-keys.ts — which catalog entries carry a live specimen on the page,
 * by the key `pieceKey` derives from the entry's name (the first code span,
 * else the slug of the plain name). The UI's specimen map is typed against
 * this list, and catalog.test.ts checks every key against the real file — so
 * a renamed or retired catalog row fails the build here instead of silently
 * orphaning a specimen.
 */

export const SPECIMEN_KEYS = [
  // 1 · the substrate
  "cell",
  "durable",
  "control",
  "scope",
  "ensureAiuiGlobal",
  // 2.1 · controls and cells in the prose
  "ControlSlider",
  "ControlScrub",
  "CellView",
  "CellText",
  "Dropdown",
  // 2.2 · mathematics
  "TeX",
  "RichTeX",
  // 2.3 · diagrams
  "Mermaid",
  // 2.4 · ink
  "PencilSurface",
  // 2.5 · attention
  "Lens",
  // 2.6 · data views
  "PlotFigure",
  // 2.7 · views for agent material
  "ToolLog",
  "JsonView",
  "TextView",
  // 3 · containers
  "the-page",
  "the-card",
] as const;

export type SpecimenKey = (typeof SPECIMEN_KEYS)[number];

/** Specimens that follow a whole section rather than one entry, by section id. */
export const SECTION_SPECIMEN_IDS = ["4-the-agent-surface"] as const;

export type SectionSpecimenId = (typeof SECTION_SPECIMEN_IDS)[number];
