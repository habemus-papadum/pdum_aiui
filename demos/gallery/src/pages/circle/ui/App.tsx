/**
 * App.tsx — the circle notebook, arranged as a paper. A short intro, then the
 * interactive **drawing board** (a self-contained dark figure — the same
 * "journal plate" convention the sim canvases use, framed by the panel border),
 * then the scoring theory.
 *
 * Unlike the standalone demo this is NOT fixed to the viewport: the board is a
 * relatively-positioned box under the gallery header, and every panel that was
 * `fixed` there is `absolute` within `.circle-board` here (page.css). The stage
 * ref adopts the durable pencil canvas and arms it for local input — the one
 * imperative bridge; everything else is a pure reader of the cells and signals.
 */

import type { JSX } from "@solidjs/web";
import { paper } from "../model/store";
import { CenterGhostLayer } from "./CenterGhostLayer";
import { Dock } from "./Dock";
import { FitOverlay } from "./FitOverlay";
import { GuideModeToggle } from "./GuideModeToggle";
import { MathSection } from "./MathSection";
import { StatsPanel } from "./StatsPanel";

export function App(): JSX.Element {
  const adoptStage = (el: HTMLDivElement): void => {
    el.append(paper.canvas);
    paper.setActive(true);
  };

  return (
    <div class="app circle-page">
      <div class="app-main">
        <header class="app-head">
          <h1>
            <span class="accent">circle</span> · the meter
          </h1>
          <p class="app-sub">
            Draw a circle in one stroke and the app measures how round it was — a calligraphy-style
            drill. The ink vanishes after a few seconds; the score stays.
          </p>
        </header>

        <section id="draw" class="page-section">
          <p class="section-lead">
            Draw anywhere on the board below. Statistics update live as you go and freeze when you
            lift; a new stroke starts a new turn. The <span class="ctrl">guidance</span> switch sets
            how much help you get: <b>Guide</b> tracks the best-fit circle live (easy, but
            traceable), <b>Zen</b> shows only the fitted centre as a ghosting dot — focus there and
            the shape is revealed on lift — and <b>Blind</b> reveals nothing until you finish. The
            fit overlay (dashed circle, tilted ellipse, centre) draws the numbers back onto your
            ink.
          </p>
          <div class="circle-board">
            <GuideModeToggle />
            <div class="stage" ref={adoptStage}>
              <CenterGhostLayer />
              <FitOverlay />
            </div>
            <StatsPanel />
            <Dock />
          </div>
        </section>

        <section id="scoring" class="page-section">
          <h2>how it's scored</h2>
          <p class="section-lead">
            Every statistic is closed-form geometry over the stroke's points — no fitting library,
            no iteration. A best-fit circle (Kåsa's algebraic method) is the yardstick; its radial
            CV becomes the <b>roundness</b>, the second-moment ellipse gives <b>eccentricity</b> and
            tilt, and the total turning about the centre gives <b>completeness</b>. The headline
            score multiplies roundness by completeness, so both an egg and a half-circle read as
            clearly imperfect — for different reasons the panel spells out.
          </p>
          <MathSection />
        </section>
      </div>
    </div>
  );
}
