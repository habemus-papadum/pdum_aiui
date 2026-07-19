/**
 * MathSection.tsx — the scoring maths, as a notebook section (not the demo's
 * floating card). The formulas the `stats` cell actually runs, rendered with
 * `TeX` from aiui-viz/site so each carries its `data-tex` stamp. These mirror
 * `model/circle.ts` one-to-one — edit them together.
 */

import { TeX } from "@habemus-papadum/aiui-viz/site";
import type { JSX } from "@solidjs/web";

interface Item {
  label: string;
  tex: string;
  wide?: boolean;
}

const ITEMS: Item[] = [
  {
    label: "Best-fit circle (Kåsa)",
    tex: "\\min_{D,E,F}\\sum_i\\left(x_i^2+y_i^2+Dx_i+Ey_i+F\\right)^2",
  },
  {
    label: "Centre & radius",
    tex: "c=\\left(-\\tfrac{D}{2},-\\tfrac{E}{2}\\right),\\quad r=\\sqrt{c_x^2+c_y^2-F}",
  },
  {
    label: "Radial CV (wobble)",
    tex: "\\mathrm{CV}=\\frac{1}{r}\\sqrt{\\tfrac1n\\textstyle\\sum_i(\\lVert p_i-c\\rVert-r)^2}",
  },
  {
    label: "Roundness",
    tex: "R=\\max\\!\\left(0,\\;1-2.9\\,\\mathrm{CV}\\right)",
  },
  {
    label: "Moment ellipse (eigenvalues)",
    tex: "\\lambda_{1,2}=\\tfrac{S_{xx}+S_{yy}}{2}\\pm\\sqrt{\\left(\\tfrac{S_{xx}-S_{yy}}{2}\\right)^2+S_{xy}^2}",
    wide: true,
  },
  {
    label: "Eccentricity & tilt",
    tex: "e=\\sqrt{1-\\tfrac{\\lambda_2}{\\lambda_1}},\\quad \\theta=\\tfrac12\\operatorname{atan2}(2S_{xy},\\,S_{xx}-S_{yy})",
    wide: true,
  },
  {
    label: "Sweep & completeness",
    tex: "\\Theta=\\Big|\\textstyle\\sum_i\\Delta\\varphi_i\\Big|,\\quad C=\\max\\!\\left(0,\\,1-\\tfrac{|\\Theta-360^\\circ|}{360^\\circ}\\right)",
    wide: true,
  },
  {
    label: "Score",
    tex: "\\mathrm{score}=100\\cdot R\\cdot C",
  },
  {
    label: "Enclosed area (shoelace)",
    tex: "A=\\tfrac12\\Big|\\textstyle\\sum_i\\left(x_iy_{i+1}-x_{i+1}y_i\\right)\\Big|",
  },
];

export function MathSection(): JSX.Element {
  return (
    <div class="circle-math">
      {ITEMS.map((it) => (
        <div class={it.wide ? "circle-math-item wide" : "circle-math-item"}>
          <div class="circle-math-label">{it.label}</div>
          <TeX tex={it.tex} display />
        </div>
      ))}
    </div>
  );
}
