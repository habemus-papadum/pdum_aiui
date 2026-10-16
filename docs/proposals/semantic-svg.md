# Semantic and reactive SVG

Status: proposed direction, 2026-10-14. Concrete applications will establish the
document models, symbol conventions, interaction semantics, and reusable APIs.
The working package name is `aiui-svg`.

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
