/**
 * App.tsx — the gratings notebook (playbook layer 4): a paper-shaped page.
 * Overview bench first, then each section re-mounts instances of the same
 * live widgets beside the prose that explains them (double-mounting shared
 * cells is free — move a slider in one section and its twin follows).
 *
 * The page's thesis: ONE rule — a stripe pattern deflects light by an angle
 * proportional to λ × its local stripe density — carried from two slits to a
 * spectrometer to a lens, honestly computed at every step. The sibling
 * holograms notebook picks up exactly where the last section stops.
 */
import { TeX, TocRail } from "@habemus-papadum/aiui-viz/site";
import { ImagingPanel } from "./ImagingPanel";
import { SculptPanel } from "./SculptPanel";
import { SlitBench } from "./SlitBench";
import { SpectroPanel } from "./SpectroPanel";
import { TwoSourceLab } from "./TwoSourceLab";

export function App() {
  return (
    <div class="app gratings">
      <div class="app-main">
        <header class="app-head">
          <h1>
            <span class="accent">gratings</span> · steering light with stripes
          </h1>
          <p class="lead">
            Most explanations of diffraction stop at "waves interfere" — true, and useless for
            <i> building</i> anything. This notebook works at the level a designer needs: light is
            an array of phase arrows, a stripe pattern is a machine that deflects it by{" "}
            <TeX tex="\sin\theta = \sin\theta_{\text{in}} + m\,\lambda/\Lambda" />, and everything —
            spectrometers, lenses, magnifiers, and (next notebook) holograms — is that one rule
            applied locally. Every picture here is the wave equation computed live, never a cartoon;
            every dashed overlay is the one-line design rule, so you can watch them agree.
          </p>
          <p class="lead-note">
            The bench runs scaled up — λ of 4.5–13.5 µm instead of 0.4–0.7 µm — so the wave texture
            is visible on screen. Diffraction only ever cares about ratios like λ/Λ, so every angle
            is faithful; think of the colors as labels for λ.
          </p>
        </header>

        {/* ── the bench (overview) ─────────────────────────────────────────── */}
        <section id="bench" class="page-section">
          <h2>the grating bench</h2>
          <p class="section-lead">
            A plane wave (the laser, entering from the left) meets a mask of N slits on pitch Λ and
            leaves as a <b>fan of beams</b>. The dashed rays are not decoration: they are{" "}
            <TeX tex="\sin\theta = \sin\theta_{\text{in}} + m\lambda/\Lambda" /> drawn over the
            honestly-computed field. Drag <b>pitch Λ</b> — finer stripes kick harder. Drag <b>λ</b>{" "}
            — redder light kicks harder too, and that λ-proportionality is the seed of everything
            below. Tilt the <b>incident angle</b> and the whole fan shears together: the grating
            adds a fixed <i>kick to sinθ</i>, it doesn't "bend by a fixed angle". Then flip{" "}
            <b>traveling wave</b> off: the same field as a time-average — the only thing any
            detector, film, or eye ever sees.
          </p>
          <SlitBench chart />
        </section>

        {/* ── the primitive ────────────────────────────────────────────────── */}
        <section id="arrows" class="page-section">
          <h2>light is an arrow at every point</h2>
          <p class="section-lead">
            The one primitive under all of it. At a fixed instant, monochromatic light assigns every
            point in space an <b>arrow</b> (an amplitude and a phase — a complex number). The rule
            of propagation is Huygens': every lit point re-emits a circular ripple, and the arrow
            anywhere downstream is the <b>tip-to-tail sum</b> of the arrivals, each rotated by its
            travel distance (one full turn per λ). Detectors — film, eyes, sensors — cannot see the
            arrow, only its <b>length squared</b>, time-averaged. That asymmetry (fields have phase;
            detectors see only intensity) is the entire drama of the holograms notebook.
          </p>
          <p class="section-lead">
            Here are two emitters fed by one laser. <b>Drag the probe</b> around the map and watch
            the dial: where the two arrows arrive aligned, the resultant is long — a bright
            direction; where they arrive opposed, it collapses — darkness. "Interference" is nothing
            but this arithmetic. On the screen line the bright directions land as fringes with
            spacing <TeX tex="\lambda L / d" /> — squeeze <b>d</b> and the fringes spread; that
            reciprocity (fine structure ↔ wide angles) is the Fourier heart of the subject.
          </p>
          <TwoSourceLab />
        </section>

        {/* ── two → many ───────────────────────────────────────────────────── */}
        <section id="many" class="page-section">
          <h2>from two slits to a grating</h2>
          <p class="section-lead">
            Now slide <b>slits N</b> from 2 up to 40 and watch the far-field chart: the broad
            two-slit fringes sharpen into <b>needles</b> at exactly the order angles. The dial
            explains why with N arrows instead of two: in an order direction, <i>every</i> slit's
            path differs from its neighbor's by a whole number of wavelengths — mλ per step — so all
            N arrows align. A hair off that direction and the arrows curl into a closed spiral: with
            more slits, the spiral closes faster, so the needle is narrower. Needle width is angular
            precision, and it is <i>bought with aperture</i>: R = m·N. Try the{" "}
            <code>probeFirstOrder</code> tool (or park the probe on a yellow ray) and see the arrows
            lock.
          </p>
          <SlitBench chart dial />
        </section>

        {/* ── wavelength separation ────────────────────────────────────────── */}
        <section id="colors" class="page-section">
          <h2>splitting colors: the spectrometer</h2>
          <p class="section-lead">
            The kick is <TeX tex="m\lambda/\Lambda" /> — <b>proportional to λ</b>. So feed the same
            mask several wavelengths at once and each takes its own exit: a prism with no glass, and
            a linear one (equal Δλ → nearly equal Δsinθ). This is already a working spectrometer
            design surface: <b>pitch Λ</b> sets where the first-order fan lands (place it across
            your detector); <b>slits N</b> sets how fine a Δλ you can split (R = m·N = λ/Δλ); and
            the ⚠ readout shows the classic trap — the second order of violet landing on the first
            order of red (why real instruments carry order-sorting filters). Design exercise:
            separate the 9.2 and 11 µm lines with room to spare — which knob do you reach for, and
            what does it cost you in fan width?
          </p>
          <SpectroPanel />
        </section>

        {/* ── local pitch → lens ───────────────────────────────────────────── */}
        <section id="sculpt" class="page-section">
          <h2>vary the pitch, sculpt the wavefront</h2>
          <p class="section-lead">
            The deflection rule is <b>local</b>: a strip of grating deflects the light crossing
            <i> that strip</i> by its own λ/Λ(x). So a mask whose pitch varies across its face
            steers different parts of the beam differently — the designer's move is to choose Λ(x)
            so every strip's kick aims where you want. Aim them all at one point and you have built
            a <b>lens out of stripes</b>: the Fresnel zone plate, pitch λf/|x|, coarse in the
            middle, fine at the edges (see the local-pitch readouts). The focus is real — watch the
            computed wave collapse onto the ghost dot. Now drag <b>λ</b>: the focus slides along the
            axis, <TeX tex="f \propto 1/\lambda" />. The spectrometer's virtue is the lens's defect
            — one phenomenon, opposite verdicts.
          </p>
          <SculptPanel />
        </section>

        {/* ── imaging & magnification ──────────────────────────────────────── */}
        <section id="imaging" class="page-section">
          <h2>a lens made of stripes: imaging &amp; magnification</h2>
          <p class="section-lead">
            A lens that focuses is a lens that images. Replace the plane wave with a{" "}
            <b>point source</b>: its diverging arrows cross the plate, each strip re-kicks them, and
            they converge again — a <b>real image</b>, obeying the lens law{" "}
            <TeX tex="1/z_o + 1/z_i = 1/f" /> with magnification <TeX tex="M = z_i/z_o" />. Pull the
            object toward f and watch the image recede and grow: your magnifier. Everything
            geometric optics promises, delivered by stripes alone — no glass, no refraction. Then
            flip on <b>three wavelengths</b>: each color images at its own depth (the f ∝ 1/λ
            readout), and the image smears axially. Diffractive optics in broadband light needs this
            managed — by narrowing the band, or by hybrid glass+stripe designs that cancel the two
            dispersions against each other.
          </p>
          <ImagingPanel />
        </section>

        {/* ── the cheat sheet ──────────────────────────────────────────────── */}
        <section id="rules" class="page-section">
          <h2>the stripe-designer's cheat sheet</h2>
          <div class="rules">
            <div class="rule">
              <TeX
                display
                tex="\sin\theta_{\text{out}} = \sin\theta_{\text{in}} + m\,\frac{\lambda}{\Lambda}"
              />
              <p>
                The whole subject. Stripes of pitch Λ add kicks of λ/Λ to sinθ, in integer multiples
                m. Everything below is this rule, aimed.
              </p>
            </div>
            <div class="rule">
              <TeX display tex="\Lambda = \frac{\lambda}{|\sin\theta_1 - \sin\theta_2|}" />
              <p>
                Read backwards: to convert a beam going θ₁ into a beam going θ₂, you need stripes of
                exactly this pitch. Keep this one — it is the hinge to holography.
              </p>
            </div>
            <div class="rule">
              <TeX display tex="R = \frac{\lambda}{\Delta\lambda} = mN" />
              <p>
                Angular sharpness (and thus color resolution) is bought with the number of stripes
                the beam crosses — aperture, not cleverness.
              </p>
            </div>
            <div class="rule">
              <TeX
                display
                tex="\Lambda(x) = \frac{\lambda f}{|x|} \;\Rightarrow\; \text{lens},\qquad f \propto \frac{1}{\lambda}"
              />
              <p>
                Vary the pitch locally and you sculpt wavefronts: the zone plate is a lens, with
                dispersion as its price. Imaging and magnification follow the ordinary lens law.
              </p>
            </div>
            <div class="rule">
              <p class="rule-note">
                Efficiency, briefly: open-and-blocked stripes waste light (absorbed + zero order — a
                sinusoidal absorbing grating tops out at 1/16 ≈ 6% per order). Etch the stripes as{" "}
                <i>phase</i> — clear ridges that delay instead of block — and the same geometry
                reaches ~34%; sawtooth ("blazed") profiles push one order toward 100%. Same angles,
                better bookkeeping — the stripe GEOMETRY sets where light can go; the stripe PROFILE
                sets how much goes there.
              </p>
            </div>
            <div class="rule">
              <p class="rule-note">
                <b>The cliffhanger.</b> A grating steers whole beams. To make an arbitrary scene
                reappear you would need the right local pitch and orientation at <i>every point</i>{" "}
                of a film — a pattern far too intricate to draw. The second formula above says what
                it would take: stripes matched, point by point, to the angle difference between the
                light you have and the light you want. The holograms notebook shows how that exact
                pattern <i>manufactures itself</i> in a single exposure.
              </p>
            </div>
          </div>
        </section>

        <footer class="foot">
          computed with @habemus-papadum/aiui-optics — the same scalar-wave engine the unit tests
          pin down · continue with the <b>holograms</b> notebook
        </footer>
      </div>
      <TocRail />
    </div>
  );
}
