/**
 * specimens/index.ts — the live specimens, by the catalog key they hang on.
 * `SPECIMENS` is typed against the key list in model/specimen-keys.ts, so a
 * key without a component (or a component without a key) is a type error;
 * catalog.test.ts checks the keys against the real catalog file.
 */
import type { Component } from "solid-js";
import type { SectionSpecimenId, SpecimenKey } from "../../model/specimen-keys";
import { ToolsSpecimen } from "./agent";
import {
  CellTextSpecimen,
  CellViewSpecimen,
  DropdownSpecimen,
  ScrubSpecimen,
  WidgetsSpecimen,
} from "./components";
import { CardSpecimen, PageSpecimen } from "./containers";
import { MermaidSpecimen, RichTeXSpecimen, TeXSpecimen } from "./math";
import {
  CellSpecimen,
  ControlSpecimen,
  DurableSpecimen,
  GlobalSpecimen,
  ScopeSpecimen,
} from "./substrate";
import {
  InkSpecimen,
  JsonViewSpecimen,
  LensSpecimen,
  PlotSpecimen,
  TextViewSpecimen,
  ToolLogSpecimen,
} from "./views";

export const SPECIMENS: Record<SpecimenKey, Component> = {
  cell: CellSpecimen,
  durable: DurableSpecimen,
  control: ControlSpecimen,
  scope: ScopeSpecimen,
  ensureAiuiGlobal: GlobalSpecimen,
  ControlSlider: WidgetsSpecimen,
  ControlScrub: ScrubSpecimen,
  CellView: CellViewSpecimen,
  CellText: CellTextSpecimen,
  Dropdown: DropdownSpecimen,
  TeX: TeXSpecimen,
  RichTeX: RichTeXSpecimen,
  Mermaid: MermaidSpecimen,
  PencilSurface: InkSpecimen,
  Lens: LensSpecimen,
  PlotFigure: PlotSpecimen,
  ToolLog: ToolLogSpecimen,
  JsonView: JsonViewSpecimen,
  TextView: TextViewSpecimen,
  "the-page": PageSpecimen,
  "the-card": CardSpecimen,
};

export const SECTION_SPECIMENS: Record<SectionSpecimenId, Component> = {
  "4-the-agent-surface": ToolsSpecimen,
};
