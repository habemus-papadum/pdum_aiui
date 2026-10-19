# Semantic and reactive SVG

Status: proposed direction; the five interaction experiments and two editing
studies have been reviewed and their lessons consolidated on 2026-10-19. The
exploration is paused at the user's request. The working package name remains
`aiui-svg`; no public SVG package or general document schema has been established.

Start with the [consolidated lessons](./semantic-svg-lessons.md) for the current
conclusions, implementation boundaries and questions to retain. The design
material and experiment history below preserve the proposal's development; they
are not an instruction to continue adding studies.

AIUI should provide a SolidJS-driven SVG layer for rich, interactive diagrams.
Electrical circuits, mechanical diagrams, graphs, and other structured visual
documents should be readable, expressive, and directly editable. People should
be able to drag and annotate their elements, while programmatic changes,
including changes made by an agent, update the same diagram.

The semantic part is the relationship between what a diagram depicts and the
structured information behind it. A transistor has an identity, parameters, and
connections; its visible symbol expresses that information and provides a place
to interact with it. The reactive part is how those symbols and their behavior
respond to changing documents, application state, and user input through Solid.

The intended foundation combines structured documents, expressive symbol
families, direct manipulation, and pencil input. Its specification should develop
through concrete applications, following the approach used for
[Pencil](../../packages/aiui-pencil/docs/architecture.md).

## Structured documents and their views

A domain document represents the knowledge being worked on: circuit components
and connections, mechanical parts and relationships, graph nodes and edges, and
the layout or annotations relevant to that application. SVG provides an
interactive view of that document.

The document should remain accessible as structured data and should be suitable
for storage as structured text. A person or agent should be able to inspect and
modify it programmatically. Document schemas, serialization formats, and the
division between domain content and presentation information remain open.

The intended editing loop is:

1. Render the domain document as an SVG diagram through Solid.
2. Interpret direct interaction with the diagram as an application edit.
3. Apply that edit to the document.
4. Reactively update the diagram and any other views of the document.

Programmatic edits enter the same document model. Moving a component with a
pointer, changing its parameters through a control, and asking an agent to change
it should produce consistent document state and visible results. The SVG DOM is
a rendered view; the structured document retains the information needed to
reconstruct and continue editing the work.

Visual parts need an association with the domain objects they represent so that
selection, annotation, and edits have meaningful targets. How that association is
expressed in the library is a design question for the applications.

## Expressive symbol families

Symbols should support systematic variations while retaining a recognizable
identity. A transistor symbol, for example, might vary subtly to convey a device
parameter such as width. A family of symbols can share a common visual language
while exposing different parameters, states, and emphasis.

The aim is a customizable vocabulary of symbolic information with rich visual
texture. A diagram can communicate both which objects are present and what is
happening to them. Relevant dimensions may include geometry, stroke treatment,
color, opacity, detail, and motion. Continuous values should be able to drive
continuous changes in appearance where that helps understanding.

The reference is the expressive range of an icon family with coordinated variants
and effects. There is no fixed list of symbols, variants, or effects at this
stage. Domain applications will determine which variations are useful and which
conventions belong in shared components.

Solid reactivity should connect these visual choices to the information they
express. An application can supply a parameter or activity state and have the
symbol respond, while preserving a coherent identity and interaction target as
its appearance changes.

## Motion and attention

Motion is part of the diagram's communication and interaction vocabulary. Useful
possibilities include:

- Entrance and exit treatments as elements appear or leave the view.
- Highlights, sparkles, or pulses that draw attention to an element.
- Marching ants along wires or connections to indicate activity or flow.
- Fading feedback, similar in spirit to the pencil's presentation effects.
- Subtle ongoing changes that express continuously varying values or state.

An audio interface with many responsive indicators is a useful reference for the
desired richness. Several elements may be active at once, each conveying
something about the system. The effects should help a person read and operate
the diagram, with enough control to choose their meaning and visual intensity.

AIUI SVG should support the transitions and effects needed for this experience.
A general animation engine is outside the proposed scope. More elaborate
animation and rendering may use Canvas or WebGPU; an application should be able
to combine those techniques with its SVG interface.

The design should distinguish changes to the document from temporary visual
feedback. A pulse or highlight can reflect application activity without becoming
a saved document edit or an undo step. The concrete effect mechanism and its
relationship to the rendering lifecycle remain to be worked out.

## Direct editing and history

The diagram should be a natural place to work. Selecting, dragging, manipulating,
and annotating elements should be integrated with the rendered symbols and their
domain meaning. Applications will define what those interactions do: moving a
component, changing a connection, adjusting a parameter, or recording an
annotation may have different rules in different domains.

Undo and redo are part of the document editing requirements. Interactive and
programmatic changes should participate in a coherent editing model, including
changes proposed or applied by agents. A person should be able to understand and
revise the result through the same diagram.

Gesture previews, committed changes, cancellation, and grouping several changes
into one meaningful undo step need deliberate treatment. The applications will
establish those semantics, along with how document validity is checked and how
agent edits are accepted. This proposal leaves the command representation and
history implementation open.

The broader [agentic patterns proposal](./agentic-patterns-and-use-cases.md)
provides the surrounding collaboration direction. AIUI SVG supplies a visual
surface for structured work that people and agents can both affect; the
application owns the meaning of its document and its edit operations.

## Pencil integration

Pencil input should be considered from the beginning. A person should be able to
work with structured symbols and freehand marks in one diagram experience:
annotating a circuit, sketching a change beside a component, or combining a
precise diagram with handwritten explanation.

Pencil already separates editable ink and its presentation from application
interpretation. Semantic SVG should compose with that separation. An application
can retain strokes as annotations or interpret them as proposed domain edits.
How drawing, selection, manipulation, and interpretation fit together will be
established through actual workflows.

The combined experience needs coherent coordinates and input behavior. Marks
should remain meaningfully aligned with the diagram while the view moves or
changes scale. Applications must decide whether a particular annotation belongs
to an object, a region, or the overall document, and what happens when its target
changes. SVG and pencil presentation should be able to coexist without requiring
all ink to become SVG geometry.

These views may also be useful on a pen display through the
[companion-page pattern](./webrtc-and-companion-pages.md). Pairing and transport
remain separate responsibilities; the same diagram and pencil composition
should be useful directly in the main application.

## Package direction

The proposed home is an `aiui-svg` package. Its reusable responsibilities would
include reactive SVG composition, expressive symbol behavior, interaction
support, and integration points for structured editing and pencil input.

Domain applications supply the meaning of a circuit, mechanical diagram, or
graph. Pencil supplies editable stroke input and its presentation. Solid supplies
the reactive connection between state and views. The useful boundaries among
those pieces should emerge as applications exercise them together.

The package name is provisional, and this proposal does not establish a public
API or a universal document schema. Symbol libraries, domain adapters, and shared
editing mechanisms may prove useful as separate pieces; their placement should
follow demonstrated reuse.

## Development through applications

Build a small set of concrete applications to develop the technology and refine
the specification. A circuit designer is a central candidate because it brings
together symbols, parameters, connections, direct editing, and annotation.
Mechanical diagrams and graphs offer additional contexts for testing which
abstractions generalize. The exact set of test applications remains open.

The applications should exercise complete workflows, including:

- Render a structured document, change it programmatically, and see the diagram
  respond.
- Manipulate the diagram directly, then undo and redo the resulting document
  edits.
- Vary parameters and activity state to evaluate symbol variations and motion.
- Combine pencil annotations with structured elements and view navigation.
- Let an agent change the document and continue working with the result through
  the same interface.
- Save and reload the structured work while preserving what is needed to edit it.

The resulting experience should guide decisions about document formats, symbol
composition, identity, interaction APIs, edit history, annotation attachment, and
effect behavior. Performance and responsiveness should be evaluated in those
applications, alongside whether the visual richness makes the information
clearer and the editing more natural.

## First experiment and the next review

[`demos/semantic-svg-lab`](../../demos/semantic-svg-lab/README.md) implements the
first increment: a fixed circuit fixture with two occurrences of one block, a
main drawing, a movable terminal-revealing lens, an aggregated navigation
overview, linked feature selection, and a resistor-value edit through the lens.
The UI and local agent tools share revision-checked edits and undo/redo.
The second increment is a guided Pencil workflow: choose, mark a frozen view,
capture, add newer ink, review a scripted change, apply and undo. An intervening
edit exercises explicit reconsideration. Original view/ink evidence remains
immutable; eligible strokes also follow their selected target in the live views.
Strokes crossing a lens boundary remain in the captured view. The site provides
the instructions and deterministic response; AI interpretation is a separate
future lab, not a dependency of this experiment.

As settled in the [workspace plan](./workspace-and-project.md#2-decisions-already-taken),
magic lenses belong to the SVG direction: a lens re-renders a local view of the
same source objects. It must preserve a meaningful mapping from what the person
points at to a source object or feature. The existing trigger/peek/detail `Lens`
is a related attention component, not this spatial projection contract. An
overview may aggregate a selected feature to its containing object; the lab
makes that distinction explicit.

The intended sequence is circuit views, restricted analytic contact geometry,
then a small statics experiment. Each gets a review before its scope grows.
After those experiments, build a fresh combined example and decide what is
shared, application-specific, worth redesigning, or discarded. Rebuilding is an
expected outcome. Retain mathematical tests, useful fixtures and behavioral
evidence; provisional schemas, component structures and package boundaries may
be replaced. A universal document schema is not a prerequisite.

The lab's README records its scope, actual agent operation surface, validation,
and questions for the next review. No circuit simulator or agent runtime is
required for this first increment. Scripted callers establish operation semantics;
interpretation of handwriting, speech and ambiguous references requires the
later real-agent integration.

The third increment tests a circle against an infinite horizontal line, with
free dragging, a one-time tangent placement, maintained tangency, and linked
geometry/equation highlighting. Its SVG radius label uses the same `createKnobs`
controller as the `RichTeX` term; both write one declared control. The deliberately
restricted half-millimetre model permits exact contact classification without a
visual tolerance. It establishes an interaction experiment, not a general
geometry kernel; the lab README records its bounds and review questions.

The fourth increment is a statically determinate beam with a pin, a roller and
one point load. It exercises force arrows linked to equilibrium terms and a
free-body projection of the same model. Both load positioning and magnitude use
the existing knob controller, shared with equation terms. This remains a small
analytic example; support editing, deformation, contact mechanics and a general
solver have not been introduced.

The fifth increment moves a circle around another, maintaining external tangency
while the centre-line normal changes direction. It distinguishes intersection,
internal tangency, containment and coincident boundaries, including an explicitly
undefined normal at coincident centres. Shared radius controls drive the SVG and
equation; authored polar parameters determine the relation, while Cartesian
constructions are numerical. The source and review questions remain in the lab.


### From scalar demonstrations to an editing study

The sixth increment changes direction: one four-joint structure can be edited,
broken, inspected and repaired. Members can be added, removed or reconnected;
joints, supports and the load can change. The construction, isolated joint,
separated member-end view, force coloring, equilibrium terms and diagnostics use
the same object references. A Pencil request previews a scripted topology change
against a frozen source revision. It can be reviewed, applied and undone without
an AI interpreter.

The deliberately small numerical solver distinguishes unique equilibrium,
infinitesimal mechanisms, redundant constraints and directionless members. It
withholds forces when the model cannot determine them. The ghost motion is a
first-order witness, not a simulated trajectory. The lab README states the rank
and residual tolerances and the physical assumptions.

This is meant to test a coherent design task, not demonstrate one more draggable
parameter. Earlier experiments established shared inputs and coordinated fixed
views but did not establish a general semantic layer. This study still keeps
mechanics, object lookup, commands and projection logic local. The next extraction
criterion is concrete: carry one useful reference/selection, diagnostic or
proposal primitive back to the circuit without requiring its schema to look like
a mechanical structure. Review the design workflow before building more domains
or deciding package boundaries.


### Paired circuit study, then consolidation

The seventh increment provides the circuit counterpart to the structure study:
a loaded resistor divider with editable explicit wires, component placement,
terminal-anchored net inspection, linked current-balance terms and scripted
Pencil repair. Open returns, passive floating islands, source shorts and bypassed
resistors have different consequences; the display preserves quantities that
remain determined instead of replacing every readout with a global failure.

This study deliberately separates schematic layout from electrical connectivity.
Its inspected net is derived from a stable terminal reference, so rewiring may
change net membership without changing the object being followed. The structure
study instead treats joint geometry as physical input. Both now consume the same
small application-local diagnostic presenter and Pencil capture adapter; neither
requires the other's domain schema.

The two editing tasks have now been reviewed. The
[consolidated lessons](./semantic-svg-lessons.md) record the shared adapters,
contrasting geometry/identity contracts, remaining hypotheses and explicit
stopping point. The study is paused; framework APIs and package boundaries remain
open. Further implementation requires a new request to resume.
