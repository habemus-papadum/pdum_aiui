/**
 * App.tsx — the holograms notebook (playbook layer 4). One virtual bench,
 * paper-shaped: the two-phase overview first, then sections that re-mount the
 * same live widgets beside the prose that explains them. The through-line
 * continues demos/gratings: a hologram is the grating you could never draw,
 * manufactured automatically by interference — and everything about using one
 * is the grating equation applied locally.
 */
import { TeX, TocRail } from "@habemus-papadum/aiui-viz/site";
import { FilmPanel } from "./FilmPanel";
import { EyeRow, HoloBench, PlaybackMap, RecordMap } from "./HoloBench";
import { KitPanel } from "./KitPanel";
import { PlaybackPanel, RemixPanel } from "./PlaybackPanel";

export function App() {
  return (
    <div class="app holograms">
      <div class="app-main">
        <header class="app-head">
          <h1>
            <span class="accent">holograms</span> · the film that remembers light
          </h1>
          <p class="lead">
            A photograph stores where light was bright. A hologram stores the light itself — the
            whole wavefront, phase included — on a medium that can only see brightness. That should
            sound impossible, and the standard explanations ("interference records, diffraction
            reconstructs") name the miracle without giving you any way to build one. This notebook
            does it the working way: a virtual bench you actually operate — split a laser, light a
            scene, integrate the film, develop it, and shine the reference back through — every
            field honestly computed by the same wave engine (and the same unit tests) as the{" "}
            <b>gratings</b> notebook. The punchline from that page's cheat sheet becomes the whole
            story here: stripes of pitch{" "}
            <TeX tex="\Lambda = \lambda/|\sin\theta_1 - \sin\theta_2|" /> convert a beam going θ₁
            into a beam going θ₂ — and interference between two beams{" "}
            <i>writes exactly those stripes by itself</i>. Recording is automatic inverse design.
          </p>
          <p class="lead-note">
            Scaled bench, as before: λ ≈ 8 µm so waves are visible; every angle and ratio is
            faithful. Lengths in µm — think of it as a millimetre-wide hologram of a millimetre-deep
            scene, which is exactly how the real thing scales up.
          </p>
        </header>

        {/* ── the bench (overview) ─────────────────────────────────────────── */}
        <section id="bench" class="page-section">
          <h2>the bench, in two phases</h2>
          <p class="section-lead">
            RECORD: one laser, split. The <b>reference</b> arm (gray guide rays) washes over the
            film as clean tilted planes; the <b>object</b> arm lights three glowing points (drag
            them!). Where the two arms cross, their interference stands still — flip{" "}
            <b>traveling wave</b> and watch phase race through while the fringe pattern itself never
            moves. That stationary pattern is the only thing the integrating film can see. Then flip{" "}
            <b>PLAYBACK</b>: the scene is gone, the film is developed, and the reference alone comes
            back — and out of stripes on a flat film, the object's wavefront re-forms. The dashed
            circles float where the points <i>were</i>: no light computes there (it is behind the
            film), yet the eye row below sees the points there — because the reconstructed wavefront
            on this side is indistinguishable from the one the points used to make.
          </p>
          <HoloBench />
        </section>

        {/* ── the kit ──────────────────────────────────────────────────────── */}
        <section id="kit" class="page-section">
          <h2>the kit: laser, beamsplitter, spreading lens</h2>
          <p class="section-lead">
            Why these parts, and not others? The film records fringes only where the two arms are
            <i> mutually coherent</i> — copies of one wave, with a stable phase relation. The{" "}
            <b>laser</b> supplies the long coherence; the <b>beamsplitter</b> makes the two copies
            (two lamps would never do — their phases wander independently in nanoseconds);{" "}
            <b>spreading lenses</b> fan the thin beam out to cover scene and film; mirrors fold the
            arms so their path lengths agree. Those are not conventions — they are the design
            constraints, and each knob here breaks one: drag <b>reference path trim</b> beyond the{" "}
            <b>coherence length</b> and the fringes fade (path-match your arms!); add{" "}
            <b>bench vibration</b> and λ/4 of drift smears them (granite tables!). The
            fringe-contrast readout is the number a working holographer watches.
          </p>
          <KitPanel />
        </section>

        {/* ── what the film sees ───────────────────────────────────────────── */}
        <section id="intensity" class="page-section">
          <h2>what the film sees: phase, smuggled into position</h2>
          <p class="section-lead">
            Film integrates |E|² — it is phase-blind. The trick that founds the whole field: compare
            the unknown object wave against a KNOWN reference, and phase becomes{" "}
            <i>fringe position</i>. Where the two arrive in step, a bright fringe; half a turn out
            of step, a dark one. The object wave's phase at each patch of film decides <i>where</i>{" "}
            the fringes sit; its arrival angle decides <i>how fine</i> they are (the gratings page's
            rule Λ = λ/|Δsinθ|, now written by the light itself). Nothing about phase is stored "as
            phase" — it is all geometry of stripes. This is also why the recording map's pattern
            must stand still: fringes that move during the exposure average to gray (the vibration
            knob above), and a reference-less exposure (turn <b>object brightness</b> up and imagine
            the reference off) stores only the featureless glow |O|².
          </p>
          <RecordMap draggable />
          <p class="map-caption">
            the recording volume again — toggle <b>traveling wave</b> in the bench above and watch
            the phase flow through a fringe pattern that never moves
          </p>
        </section>

        {/* ── the memory mechanism ─────────────────────────────────────────── */}
        <section id="memory" class="page-section">
          <h2>the memory mechanism: grains, developer, bleach</h2>
          <p class="section-lead">
            What is the film, physically? An emulsion of silver-halide <b>grains</b>. Photons arm
            grains at a rate proportional to the local intensity, so the fringe pattern prints as a{" "}
            <i>density</i> of armed grains (strip 2 — the memory is a census, not a picture). The{" "}
            <b>developer</b> turns armed grains into opaque metallic silver: the film becomes an
            absorbing stripe mask — an <i>amplitude</i> hologram, working but dim (it eats the
            light; ~6% reaches the image, the gratings page's 1/16). The <b>bleach</b> converts that
            silver into a clear salt with different refractive index: the same stripes, now written
            as phase delay — ~34% into the image. Watch the beam-split readout as you flip it. And
            the <b>emulsion resolution</b> knob is the gatekeeper: fringes here are tens of µm, but
            scale the bench to real light and they are ~0.5 µm — ordinary camera film (resolving ~10
            µm) simply cannot hold a hologram. Coarsen the knob and watch the steep-angle fringes —
            the FINE ones — die first: the image doesn't fade uniformly, it loses its off-axis
            parts.
          </p>
          <FilmPanel />
        </section>

        {/* ── playback ─────────────────────────────────────────────────────── */}
        <section id="playback" class="page-section">
          <h2>playback: one beam in, three beams out</h2>
          <p class="section-lead">
            Shine the reference back through the developed film and the multiplication R·t(x) hands
            you three beams, because t carries the fringes cos(φ_O − φ_R) and a cosine is two
            exponentials plus a bias: the <b>zero order</b> (the reference, dimmed, sailing straight
            on), the <b>image</b> — R·e^(i(φ_O−φ_R)) = the object wave, rebuilt to its exact phase —
            and the <b>conjugate twin</b> (the mirror term, converging to real foci on this side —
            the bright pinches in the map). Locally this is nothing but the grating equation: each
            patch of film carries exactly the stripe pitch that kicks the reference into the
            direction the object light left it — for a single point, those stripes ARE the gratings
            page's zone plate, zone for zone. An object is many points; the film is a sum of zone
            plates; linearity replays them all at once. The design decision on this bench: the{" "}
            <b>reference angle</b> keeps the three beams apart — drop it toward 8° and watch them
            start to shear into each other (Gabor's original in-line headache; Leith &amp;
            Upatnieks' off-axis fix is this slider).
          </p>
          <PlaybackPanel />
        </section>

        {/* ── cut the film ─────────────────────────────────────────────────── */}
        <section id="window" class="page-section">
          <h2>cut the film: every piece holds the whole scene</h2>
          <p class="section-lead">
            The most famous claim — cut a hologram in half and both halves show the whole scene — is
            now almost obvious: every scene point's light washed over the <i>entire</i> film, so
            every patch of film carries every point's zone-plate stripes. A photograph maps point →
            point; a hologram maps point → everywhere. So the film is not a picture — it is a{" "}
            <b>window</b>. Cut it down (<b>film window</b> sliders) and you are shuttering the
            window: the eye still sees every point <i>in place</i> — watch the retina peaks stay put
            on their predicted ticks — but dimmer (less film, less light) and blurrier (a smaller
            aperture resolves less; the gratings page's R = mN again, in disguise). Slide the{" "}
            <b>eye</b> along the rail for parallax — near points shift against far ones, and a small
            window cramps how far you can walk before the view runs out. Then play with{" "}
            <b>focus depth</b>: the eye must refocus between near and far points, because the depth
            is real, not painted.
          </p>
          <PlaybackMap showEye />
          <EyeRow />
        </section>

        {/* ── remixes ──────────────────────────────────────────────────────── */}
        <section id="remix" class="page-section">
          <h2>remix the playback: magnification, color, and the moving image</h2>
          <p class="section-lead">
            Nothing obliges you to play back what you recorded. The film is a fixed set of stripes;
            the output is stripes × <i>whatever beam you bring</i> — and the paraxial bookkeeping
            (the ghost dots) is two lines: image tilt a = a_p ± µ(a_o − a_r), image curvature b =
            b_p ± µ(b_o − b_r), with µ = λ_play/λ_rec. Raise <b>playback λ</b> and every kick
            strengthens: the image pulls closer (depth scales as 1/µ) — Gabor invented all of this
            in 1948 to record with electron waves (λ ~ picometres) and replay with visible light,
            buying magnification λ_light/λ_electron ≈ 100,000× with no lens at all. Swing the{" "}
            <b>playback angle</b> and the whole scene rides the beam. Record with the{" "}
            <b>spreading-lens reference</b> (bench section) and play back with a plane wave: the
            mismatch in b projects a magnified real image — the hologram as a lensless enlarger. And
            the same arithmetic shows why white light smears a transmission hologram like this one:
            every λ reconstructs at its own angle and depth at once. The fix is thickness — in a
            deep emulsion the fringes are tilted <i>layers</i>, and Bragg selection makes the film
            choose its own λ from white light: the Denisyuk reflection holograms you can view under
            a desk lamp, and the volume gratings inside modern AR waveguides.
          </p>
          <RemixPanel />
        </section>

        {/* ── the rules ────────────────────────────────────────────────────── */}
        <section id="rules" class="page-section">
          <h2>the holographer's rules to design by</h2>
          <div class="rules">
            <div class="rule">
              <p class="rule-note">
                <b>1 · One coherent source, two arms, matched paths.</b> Fringe contrast is your
                signal; path mismatch beyond the coherence length, vibration past ~λ/8, or an
                incoherent source each erase it before the film ever matters.
              </p>
            </div>
            <div class="rule">
              <p class="rule-note">
                <b>2 · The film must out-resolve your steepest fringe</b> — Λ = λ/|sinθ_o − sinθ_r|
                at the worst patch. The reference angle you choose IS a resolution budget; the
                emulsion's cutoff clips your field of view, steepest angles first.
              </p>
            </div>
            <div class="rule">
              <p class="rule-note">
                <b>3 · Off-axis enough to separate three beams</b> (image, zero order, twin) —
                sinθ_r beyond the object's angular half-width keeps them apart. Then bleach: phase
                stripes send ~5× more light into the image than absorbing ones.
              </p>
            </div>
            <div class="rule">
              <p class="rule-note">
                <b>4 · Playback is a free parameter.</b> a = a_p ± µ(a_o − a_r), b = b_p ± µ(b_o −
                b_r): wavelength scales depth (1/µ), beam angle steers the scene, beam curvature
                magnifies. Match everything → the exact original wavefront; mismatch deliberately →
                enlargers, λ-converters, and (with thick films) white-light viewable reflection
                holograms.
              </p>
            </div>
            <div class="rule">
              <p class="rule-note">
                <b>5 · The film is a window, not a picture.</b> Every patch sees every point, so any
                piece replays the whole scene — with aperture, not content, setting sharpness,
                brightness, and how much parallax you can walk. Design the film SIZE for the viewing
                experience, not for "fitting the image on".
              </p>
            </div>
          </div>
        </section>

        <footer class="foot">
          computed with @habemus-papadum/aiui-optics — record → develop → playback runs the same
          engine the unit tests pin · the on-ramp is the <b>gratings</b> notebook
        </footer>
      </div>
      <TocRail />
    </div>
  );
}
