# Semantic SVG lab

Status: five interaction experiments and two editable studies reviewed;
lessons consolidated and exploration paused, 2026-10-19. This is application-local,
replaceable prototype code; no `aiui-svg` package or general document schema is
being established. The [consolidated lessons](../../docs/proposals/semantic-svg-lessons.md)
record the findings and stopping point; the [proposal](../../docs/proposals/semantic-svg.md)
retains the broader direction. The sections below document the retained experiments;
their earlier review prompts are historical, not an active implementation queue.

```sh
pnpm -C demos/semantic-svg-lab dev
pnpm -C demos/semantic-svg-lab test
pnpm -C demos/semantic-svg-lab typecheck
pnpm -C demos/semantic-svg-lab test:browser
```

The gallery discovers this demo at `/semantic-svg-lab`. It exports a `SitePage`
and a pure-model card. Browser tests use the already installed Playwright
Chromium, start a dedicated server on port 5198 (`SVG_LAB_TEST_PORT` overrides it),
and write artifacts beneath the ignored root `node_modules/.cache/` directory.

## The first experiment

Two occurrences, A and B, share one small common-source circuit definition.
Each owns its resistor value. The main view, terminal lens and overview share
one revisioned circuit. The lens magnifies and re-renders the same geometry,
revealing terminal names and the transistor's explicit bulk-to-ground connection.
The overview aggregates selection to its containing block and navigates the main
camera; it does not pretend that an aggregate is a terminal-level view.

1. Select `a/M1/bulk` through the lens. Hide the lens; selection and electrical
   membership remain, with M1 highlighted in the main view.
2. Select `a/R1/value` through the lens, change its resistance and apply. Main,
   lens and overview update; B retains its own value. Undo and redo restore
   values with fresh revisions.
3. Drag the lens header, pan the background, change either scale, and navigate
   through the overview. Navigation makes no circuit edit and never invalidates
   the circuit-derived cell. Focus A/B are keyboard-accessible navigation helpers.
4. Begin typing a value, make a programmatic edit, then apply the draft. The
   stale draft is refused and can reload the current value.

Circuit values persist in browser local storage. History is bounded to 50 edits
and survives supported hot updates, but not a full reload. Camera, selection,
lens position and input drafts are session presentation. Storage is local to the
origin; it is not a project store or a concurrent-writer solution.

## Guided markup: the second experiment

Open `/?lab=markup` on the standalone server, or choose **Guided markup** in the
page. The gallery equivalent is `/semantic-svg-lab?lab=markup`.

The site guides five steps: choose a resistor; mark a frozen view; capture and
add a newer mark; review a scripted value change; apply and optionally undo.
The target is the explicitly selected R1 occurrence. The requested value is
6.8 kΩ, or 8.2 kΩ if the captured value is already 6.8 kΩ. Nothing attempts to
read handwriting. AI interpretation belongs in a separate later lab.

The writing sheet freezes the diagram and lens at **Begin marking**, with the
selected feature, circuit revision, viewport size, and main/lens transforms.
It uses copied SVG styles and a self-contained Georgia font stack. That exact
sheet is what the person sees while drawing and what the evidence retains.
Resizing scales the sheet and input together; changing the coordinate mapping
cancels an active stroke rather than joining samples from different frames.
Pencil supplies actual pen/mouse/finger input and immutable stroke captures.

**Capture request** records completed ink and a separate immutable image of it.
The next step requires a newer mark before review, making capture isolation
visible. During review, a value badge previews the change on the live circuit.
The original request remains beside it. A later selection does not retarget it.

Two attachment behaviors are exercised:

- The captured view and ink stay fixed, including marks that cross a lens edge.
- Strokes with one clear inverse projection become an annotation relative to
  the selected feature. They appear through the live main and lens transforms.
  Conservative brush bounds that intersect a lens boundary/header are kept in
  the capture only; the lab does not splice or warp those strokes. This is an
  explicit selected-target association, not recognition of what a stroke means.

**Try an intervening edit** makes a real, undoable change to the same resistor.
The original proposal is then stale. **Try original proposal** demonstrates
refusal without retiring ink. **Review current circuit** explicitly refreshes
its expected revision while preserving the original evidence and requested
value. **Keep current value** declines without changing the circuit or ink.

Apply uses the existing revision-checked operation and produces one circuit undo
step. Only unchanged captured stroke records are retired; newer or revised ink
survives. **Undo circuit change** restores the model value, not the separate ink
history; the archived request remains available. It refuses to undo if another
writer has since made the latest edit. **Start another exercise** clears the
current exercise's working ink and evidence but keeps circuit values/history.

Markup state survives tab switches and supported component/graph hot updates.
It is session-only and is lost on full reload. There is no remote service or
model call. Chromium tests exercise mouse input and narrow layouts; physical
Wacom/iPad input quality still needs use on those devices.

## Circle and line: the third experiment

Open `/?lab=contact`, or choose **Contact geometry**. Drag the circle toward the
line; inspect the signed gap, the lowest circle point P, its projected foot Q,
the tangent through P and the upward line normal. **Touch once** makes h=r but
leaves motion free. **Keep tangent** maintains h=r during horizontal dragging
and radius changes; releasing it retains the current centre.

The radius label in the SVG uses `createKnobs` and `KnobReadout`. The equation
uses `RichTeX` and a `Term` bound to that same declared `radius` control. Both
provide the existing scrub gesture, keyboard steps, bounds, readout and control
stamps. Selecting h or g in the equation highlights its geometric counterpart.
Two-dimensional circle dragging and the experiment's feature selection remain
local. No history, persistence or general constraint solver was added.

The mathematical scope is deliberately small: a circle above the infinite
horizontal line y=0, with authored lengths restricted to bounded half-integer
millimetres. The gap g=h−r and the witness coordinates use exactly representable
arithmetic in this domain; no pixel tolerance determines contact. SVG painting
and screen-to-model pointing still use ordinary floating-point transforms.
Negative g means the circle crosses the line, not a negative Euclidean distance.
P is the lowest point, not an intersection witness in the crossing case.
Circle–circle contact is a separate fifth experiment. Arbitrary curves,
rotation dynamics and rolling remain later work. These bounds are a prototype choice, not a geometry-kernel contract.

`contact.ts` holds the pure geometry and projections; `contact-store.ts` declares
radius, position, the tangency relation and operations. The existing graph adds
one contact cell, independent of circuit and markup state. `ContactLab.tsx`
composes the SVG and equation. Scoped tools are `contact/inspect`,
`contact/move-circle`, `contact/hold-tangency`, `contact/touch-line`,
`contact/select-feature`, and `contact/reset`; the standard `set` writes
`semantic-svg-lab/contact/radius`.

Review questions: does keeping tangency feel like preserving an intention?
Does scrubbing the same radius in an equation and a drawing feel consistent?
Are the geometric witnesses useful, or is the initial view too busy?

## Beam statics: the fourth experiment

Open `/?lab=statics`, or choose **Beam statics**. A rigid, weightless four-metre
beam has a pin at A, a vertical roller at B and one downward point load between
them. Drag the load arrow along the span, or scrub its W label. Both the arrow
position and force magnitude use the existing `createKnobs` controller; the
position gesture's span matches the displayed beam. The two `RichTeX` equations
bind W and x to those same controls, with unique term IDs for repeated W terms.
Selecting a reaction highlights it in the drawing and both relevant equations.

The analytic model solves RA + RB = W and RB L = W x. Authored W is 20–200 N in
5 N steps; the position is 0–100% of the span in 1% steps (displayed as metres).
Reaction arrows use one fixed force scale. Inspection returns the unrounded
floating-point force/moment residuals; displayed reactions use two decimals.
There is no beam bending, self-weight, horizontal loading, support lifting,
overhang, general solver or dynamics. The zero-reaction endpoint cases are
represented explicitly.

**Free-body view** removes only the support symbols. It preserves forces,
selection and model results. **Centre load** demonstrates equal sharing;
**Reset beam** restores the initial example. No history or persistence was added.
`statics.ts` owns the pure solution, `statics-store.ts` its scoped controls and
operations, and `StaticsLab.tsx` the views. The shared graph adds one cell.
Tools: `statics/inspect`, `statics/center-load`, `statics/select-feature`,
`statics/reset`; standard `set` writes the `statics/load`, `statics/loadPosition`
and `statics/freeBody` controls beneath the `semantic-svg-lab/` scope.

Review questions: does dragging a physical load with the numeric knob controller
feel direct? Does switching to a free-body view clarify what the supports do?
Does the link between arrows and moment terms make the equilibrium readable?

## Two circles: the fifth experiment

Open `/?lab=pair`, or choose **Two circles**. A's centre is fixed at the origin;
B is positioned by a polar distance and bearing. Drag B freely, **Touch once**
for one external tangent placement, or **Keep tangent** to orbit at contact.
While held, either radius change keeps d=rA+rB. Releasing tangency preserves the
current position. Both radii use the shared SVG/equation knob controller.
**View scale** changes presentation only; 1× fits the entire allowed range.

The relation distinguishes separation, external tangency, intersection, internal
tangency, containment and coincident circles. Intersection points are shown for
crossing boundaries; the common tangent appears only at actual point tangency.
The external gap g=d−(rA+rB) is not a minimum boundary distance in containment.
**Align centres** exposes the degenerate case: no unique centre-line normal is
invented, and tangency cannot be enabled until B is moved to choose a direction.
Matching the radii then produces coincident boundaries, not a single contact.
The n and t terms in the readout highlight their drawn geometry.

Radii and centre distance use bounded 0.5 mm increments; bearing uses whole
degrees. Relation predicates compare the authored distance to the sum and
absolute difference of the radii, independently of display pixels. Cartesian
centres, normals and intersection constructions use ordinary trigonometric and
square-root arithmetic and are numerical approximations. Maintained tangency is
a relation in the model; the facing-point constructions share the same expression
at external contact. This is a restricted analytic experiment, not a general
robust-geometry library or a rolling simulation.

`circle-pair.ts` holds the model and projections; `circle-pair-store.ts` owns its
scope and controls; `CirclePairLab.tsx` composes the view. Tools are
`pair/inspect`, `pair/move-circle`, `pair/set-pose`, `pair/hold-tangency`,
`pair/touch-once`, `pair/align-centres`, `pair/select-feature`, `pair/reset`.
The standard `set` writes `semantic-svg-lab/pair/radiusA`, `radiusB` and `pairZoom`.

Review questions: is holding a relation while changing its parameters intuitive?
Are facing points, actual contact and intersection points distinguishable enough?
Does the undefined-normal case read as a mathematical fact rather than a broken
interface? The shared pieces demonstrated so far are controls, numeric gestures,
reactive observations and addressable equation terms; geometric models and
constraint meanings remain local to their experiments.

## Ownership

- `src/model/circuit.ts`: fixed symbol definition and placements, feature
  references, connectivity, parameter validation, serialization and history.
- `src/model/projection.ts`: pure world/view/lens transforms and viewport bounds.
- `src/model/store.ts`: durable roots, view controls and domain actions.
- `src/model/graph.ts`: disposable circuit and inspection cells. It includes a
  lexical `import.meta.hot.accept()` because Vite's import analyzer cannot see
  the accept call inside `hotCellGraph`; the helper still owns graph replacement.
- `src/ui/CircuitScene.tsx`: shared drawing, with occurrence-qualified feature
  stamps. Each appearance has its own SVG nodes; references identify the source.
- `src/ui/CircuitBoard.tsx`: view navigation, lens clipping, input and editing.
- `src/model/markup.ts`: pure capture/proposal semantics and projection-aware
  ink attachment. `markup-store.ts` owns the guided state and declared actions.
- `src/ui/GuidedMarkup.tsx`, `MarkupPad.tsx`, `MarkupOverlay.tsx`: instructions,
  the disposable Pencil surface, and annotations/proposals on the live circuit.
- `src/ui/markup-images.ts`: self-contained diagram snapshots and independently
  rendered ink images. Original samples remain available in the capture.

Model/reactivity tests cover identities, hidden connectivity, validation,
revision checks, history, coordinate inverses and dependency isolation. Browser
tests cover real pointer/keyboard input, linked updates, stale drafts, reload,
and widths 360/390/414/1440. Guided tests also exercise immutable captures, later
ink preservation, explicit conflict review, cancellation and boundary-crossing
marks. Visual and component/graph HMR checks supplement them.

## Agent integration boundary

The current local tool surface is registered as `semantic-svg-lab`:

- `inspect-circuit`: bounded circuit facts, feature keys, revisions, semantic
  selection, camera/lens state and history counts.
- `select-feature`: a qualified key and the originating view.
- `set-resistance`: `{ key, ohms, expectedRevision }`, through the same operation
  as the lens editor. One operation is one undo step.
- `undo`, `redo`, `reset-circuit`, `navigate`, `reset-view`.
- `begin-markup`, `capture-markup`, `review-markup`, `apply-markup` drive the
  guided exercise; their gates require actual completed input.
- `interrupt-markup`, `reconsider-markup`, `cancel-markup`, `undo-markup`,
  `restart-markup` exercise review and recovery.
- `inspect-markup`: phase, source revision, stroke counts/IDs, attachment counts,
  proposal and stale status, without raw samples or image payloads.
- Standard `report`, `set`, `locate`, `read-page`, selection and source tools.

`inspect-circuit` supplies semantic selection; the standard `selection` tool
continues to describe browser text selection. This prototype has not extended
that framework-wide reader contract. Its scoped report includes the circuit
snapshot. Tool calls can drive the lab without an agent runtime or credentials.

Annotated captures, fixed proposed edits, explicit review and guarded commit are
now exercised locally. Focused neighbourhood queries, general proposal types,
agent activity/cancellation feedback and real interpretation remain later work.
Scripted tool calls validate the application side; they do not validate
interpretation of handwriting or speech.

## Review before the next increment

- Does a movable re-rendering lens make hidden features easier to understand and
  select? Does magnification's discontinuity at its boundary help or distract?
- Is editing inside the lens useful, or does an anchored editor obscure the
  relationship we want to inspect?
- Does the overview communicate selection honestly when it aggregates a feature
  into a block? What should happen for features absent from another projection?
- Which parts survive a contact-geometry model without adopting circuit terms?

The next review should ask whether freezing the view while writing is fluid
enough, whether the two attachment behaviors are understandable, and whether
reviewing a stale request needs a different presentation. The contact experiment now tests a second domain and the existing equation
knobs. AI interpretation remains a separate lab.
The original transistor fixture has no electrical simulation, topology editing
or component dragging. The later DC study below adds those bounded interactions.
General routing/DRC, exploded-view editing and a real agent runtime remain outside scope.
Richer lenses and a review of shared abstractions remain possible next
experiments. Keep useful
fixtures and behavioral evidence when rebuilding; these component boundaries
and provisional reference shapes are not public contracts.

## Editable structure: the sixth study

Open `/?lab=structure`, or choose **Editable structure**. The task is to break,
inspect and repair one four-joint pin-jointed frame. Select AC and remove it;
follow the object-targeted diagnostic to a joint; add AC or BD using **Connect
joints**, or draw a scripted pencil request. This introduces actual topology
changes after the preceding fixed-topology experiments.

- Drag joints (0.1 m grid; arrow keys, Shift for 0.5 m). A drag previews a live
  analysis and commits one revision/undo step on release; Escape cancels. A
  concurrent edit invalidates the gesture's revision. The camera is held during
  the gesture, then refits. Four joint identities stay fixed; joints cannot be
  added/deleted in this increment.
- Add/remove members and reconnect an existing member through the inspector.
  Reconnecting preserves its ID while its endpoint label changes. Removing the
  selected member retires that selection. Undo/redo restore source objects with
  fresh revisions, and newly added members never reuse an undone member's ID.
- Select a joint to inspect its free body. Select a member/force through the
  construction, joint view, value list, or `RichTeX` equation. These appearances
  address the same source reference. **Separate member ends** is a presentation
  change; **Force lens** colors the construction by tension/compression. Neither
  changes the physical problem. A crossing is not an implicit joint.
- Change any joint's support (none, pin, x-reaction roller, y-reaction roller),
  the downward load's joint, or its magnitude. Supports are bilateral axis
  constraints, not contact/lift-off models. Coincident connected joints have no
  member direction and produce an explicit invalid-geometry result.
- **Sketch a brace** freezes the source model and uses the real PencilSurface.
  It proposes AC if absent, otherwise BD if absent. The requested endpoints are
  stated before drawing: no recognition takes place. Capture preserves ink and a
  bitmap; review shows a dashed added member and the before/after analysis. Apply
  uses the same revision-checked edit as manual input; a stale request requires
  starting again. The request remains for comparison after apply/undo. This is
  a topology proposal, not another ink-capture stress test.

`structure.ts` contains a small equilibrium-matrix assembly and partial-pivot
Gauss–Jordan reduction. Positive member force means tension. For four joints the
matrix has eight equilibrium rows; columns are member axial forces and support
reaction components. Left-nullspace freedoms identify infinitesimal mechanisms;
right-nullspace freedoms identify nonunique forces. Counts alone are not used
as a stability test. A stable, determinate result must also pass a force-residual
check before forces are displayed. Other cases withhold member/reaction values:

- A mechanism may or may not be compatible with this particular load. Both cases
  are distinguished. One normalized nullspace direction is drawn as an exaggerated
  ghost; it is not a finite-motion path or a deformation prediction.
- Redundant constraints need material stiffness and compatibility to select a
  solution. Adding both diagonals deliberately reaches this boundary.
- Rank uses a `1e-10` absolute pivot tolerance on dimensionless direction columns;
  residual acceptance is `1e-7 × max(1, load)` N. Length normalization and solving
  use ordinary floating point. These are bounded numerical experiments, not an
  exact geometry kernel or engineering validation. Units are metres and newtons.

The formulation follows joint equilibrium as presented in
[MIT's truss notes](https://ocw.mit.edu/courses/1-050-solid-mechanics-fall-2004/resources/emech5_04/)
and the equilibrium/kinematic nullspace relationship described in
[*Mechanisms and states of self-stress of planar trusses*](https://paulino.princeton.edu/courses/cee307/2016/class_notes/12012016/IJSS_final_published_paper_1.pdf).
The limited implementation and its numerical policy are this lab's choices.
There is no stiffness, deformation, strength, buckling, dynamics or general CAD.

The durable store declares `structure/inspect`, `structure/select`,
`structure/edit`, `structure/undo`, `structure/redo`, `structure/reset`,
`structure/begin-brace`, `structure/preview-brace`, `structure/apply-brace` and
`structure/close-brace`. Inspect returns source objects, reference keys, diagnostics,
force terms, numerical residuals and a compact proposal, without serializing ink.
The generic edit has `{expectedRevision, edit: {kind, ...}}`; its parameter shapes
are included in inspect. Standard `set` controls are `forceLens`, `explodedJoint`
and `showMotion` beneath `semantic-svg-lab/structure/`. Draft position previews
are transient; inspect reports the committed source. Reset restores the named
fixture as an undoable edit. State is session-only and survives supported HMR.

The shared pieces are scopes/cells/actions, Pencil, RichTeX and design styles.
Topology commands, history, reference resolution, 2D dragging, projections and
physics remain local. Dynamic equation term sets also exposed unnecessary empty
note-layer invalidations in RichTeX/NoteLayer; their equality gates were repaired
in the existing library, with a dynamic-term regression test.

**Review next:** can someone repair the structure using the diagnostic, rather
than following the instructions? Do isolated and separated joint views explain
the same identity clearly? Is the pencil proposal's consequence clear before
apply? Once that interaction is useful, transfer one candidate primitive—opaque
selection references, targeted diagnostics, or revisioned proposals—to the
circuit. Successful transfer across these unrelated schemas would justify
extraction. Another isolated scalar-geometry lab would not answer that question.

## Editable circuit: the seventh study

Open `/?lab=dc`, or choose **Editable circuit**. The task is to retain 6 V at OUT
with a connected load, then break, inspect and repair the connections. The fixture
has a 12 V ideal source, R1=1 kΩ, R2=2 kΩ, and RL=2 kΩ. It is a separate study from
the original fixed transistor drawing: its electrical calculations are real,
bounded linear DC calculations, not a transistor simulator or an Analog Canvas
integration. Analog Canvas remains a reference for richer symbols, connectivity,
hierarchy and editing; this study uses explicit terminal-to-terminal wires.

Try removing W3, following the diagnostic to the return terminals, and reconnecting
R2/b to V1/n with **Connect terminals**, the inspector, or **Sketch return**. The
case buttons replace the electrical model as one undoable edit. They distinguish:

- **Open return:** OUT rises to 12 V with zero source current. The voltages are
  defined, but the loaded-divider task fails. This is not a floating-node error.
- **Isolated load:** the referenced divider gives 8 V. RL's absolute terminal
  voltages are undetermined; its voltage difference and current are known to be
  zero in this passive DC island. Valid quantities remain visible independently.
- **Shorted supply:** ideal-wire connectivity contradicts the nonzero source
  voltage. Voltages and currents are withheld until the bypass is removed.
- Directly bypassing a resistor gives a separate diagnostic, with zero voltage
  drop across that resistor. Cyclic ideal wires are allowed; this lab does not
  invent a unique current allocation among individual ideal wires.

The schematic and the separated-terminal view share stable `pin/`, `part/` and
`wire/` references. Current-balance terms and readouts select the resistor/source
that produces the term. The inspected electrical net is anchored to a **terminal**:
net membership can merge or split without silently retargeting that anchor. Nets
are derived equivalence classes, not persistent object IDs. Reconnecting a wire
preserves its identity; deleting the selected wire falls back to its anchor.

Moving a symbol is a presentation edit. Wires follow its terminals; changing
screen positions, wire crossings or overlaps never establishes connectivity or
recomputes electrical analysis. This is a different geometry contract from the
structure study, where joint positions enter the physical equations. Layout is
session-durable, separate from electrical undo history. Drag or use arrow keys;
Escape cancels a drag. **Reset layout** leaves all circuit edits intact.

Placement is explicitly authored; routing is the small deterministic function in
[`dc-layout.ts`](./src/model/dc-layout.ts). It joins moving terminals with straight
or orthogonal segments, using fixed offsets or a midpoint for the horizontal
segment. It does not search around obstacles or optimize a whole schematic.
The [routing account](../../docs/proposals/semantic-svg-lessons.md#2-treat-geometry-layout-and-routing-as-separate-responsibilities)
records the exact rules and their limitations.

Wiring/value edits share the revision-checked `dc/edit` operation and bounded
undo/redo history. Inspector drafts retain their source revision and are refused
if another electrical edit intervenes. The Pencil workflow captures actual input
on a frozen source model and layout, then previews one stated connection,
R2/b → V1/n. Before/after output values are computed from that proposed topology.
Changing the live layout does not invalidate the electrical proposal; a circuit
edit does. Interpretation is scripted, with no agent/API dependency. Original ink
and the original layout remain available after apply. No physical pen-device
quality claim is made by the mouse/keyboard browser checks.

The pure `dc-circuit.ts` model derives nets from explicit wires, identifies
unreferenced resistor islands, and solves referenced unknown node voltages from
KCL and Ohm's law. The conductance rows are scaled before partial-pivot elimination
(`1e-12` pivot threshold); the maximum non-source KCL residual must be at most
`1e-9` A. Inspect also returns a power-balance residual. Resistance is bounded to
integer ohms in [100,100000]; the source is 1–24 V, quantized to millivolts. The
6 V design target permits ±0.05 V. These are numerical prototype policies. The
formulation follows the node-method treatment in
[MIT's Circuits material](https://ocw.mit.edu/courses/6-01sc-introduction-to-electrical-engineering-and-computer-science-i-spring-2011/pages/unit-3-circuits/circuits/).
No AC, transients, nonlinear devices, tolerances, parasitics, smart routing,
component creation/deletion, general ERC or manufacturing rules are implemented.

`dc-store.ts` declares the `dc/inspect`, `dc/select`, `dc/edit`, `dc/place`,
`dc/reset-layout`, `dc/load-case`, `dc/undo`, `dc/redo`, `dc/begin-return`,
`dc/preview-return`, `dc/apply-return`, and `dc/close-return` actions. Standard `set`
controls are `semantic-svg-lab/dc/voltageLens` and `terminalNames`. Inspect returns
objects, pin membership, voltages, branch currents, diagnostics, residuals,
selection, layout and compact proposal state. Layout is not a dependency of the
analysis cell. The existing agent toolkit exposes these operations without a
live agent runtime. State lasts for the session and supported HMR, not reload.

Two small pieces are now actually shared with the structure study, still inside
the lab: `TargetedDiagnostic`/`TargetedDiagnostics` accept opaque reference strings,
label resolution and selection callbacks; `PencilCapturePad` adapts the existing
Pencil toolkit to a fixed capture plane. Neither imports a circuit or structure
schema. The physics, reference resolution, selection policy, proposal meaning and
edit models remain domain-specific. This is evidence to review, not a public API.

**Stopping point reached:** the user has reviewed both editing studies, and
one [set of lessons](../../docs/proposals/semantic-svg-lessons.md) has been recorded.
The exploration is paused. Keep these examples available; further studies or
package extraction are not part of the current task.
