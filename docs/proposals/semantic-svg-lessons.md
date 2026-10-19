# Semantic SVG: lessons from the interaction studies

Status: consolidated on 2026-10-19 after review of the circuit and structure
studies. This exploration is paused at the user's request. The package direction
remains proposed; no public SVG API or general document schema has been chosen.

The [proposal](./semantic-svg.md) retains the original design direction and study
history. The [lab README](../../demos/semantic-svg-lab/README.md) records runnable
examples, operations, mathematical assumptions and verification. This document
is the consolidated account to consult before resuming work.

## What we are trying to build

Semantic SVG is a way to coordinate technical drawing and interaction around
meaningful source objects. A source object can appear in a schematic, a lens, an
equation, an isolated view or a diagnostic. People and agents should be able to
find it, understand the relevant relationships, propose an edit and inspect the
consequences through those appearances.

The candidate shared layer concerns references, appearances, attention, edits
and evidence. Applications retain their own models and computations. A useful
interface should accept a circuit or a mechanical model through an adapter;
neither should have to adopt the other's document structure.

## What the studies establish

The first five experiments covered circuit lenses and overviews, scripted Pencil
review, shared drawing/equation controls, restricted contact geometry and beam
statics. They showed individual mechanisms and exposed integration details. The
last two studies exercised a more complete task: edit a design, encounter an
unsatisfactory or unresolved result, inspect it and repair it.

| Question | Structure study | Circuit study | Implication |
| --- | --- | --- | --- |
| What does moving an object mean? | Moving a joint changes physical geometry and forces. | Moving a symbol changes presentation; electrical analysis is unchanged. | The application owns the meaning and dependencies of a move. |
| What remains identifiable after an edit? | Joints and surviving members; reconnecting a member retains its ID. | Components, terminals and surviving wires; nets are derived and may merge or split. | Source identity and derived membership need different treatment. |
| What does an alternate view explain? | A joint's forces and separated member ends. | The terminals belonging to one electrical net and its current balance. | A projection can change arrangement and visible information while retaining references. |
| What does failure mean? | A mechanism, redundant constraints or a directionless member. | An open return, a floating island or contradictory source/wire constraints. | Diagnostics and the validity of quantities come from domain analysis. |
| What does a proposed edit depend on? | The captured structural revision, including physical positions. | The captured electrical revision; later symbol placement does not invalidate it. | Preconditions follow semantic dependencies, rather than every visible change. |

These are implementation examples and informal user review, not a comparative
usability study. The completed lab had 72 model/reactivity tests and 33 browser
tests at the end of implementation, plus type, build, visual and HMR checks. That
supports specific behavioral claims; it does not establish a general framework,
large-document performance, real-agent comprehension or physical pen quality.

## Lessons to retain

### 1. Keep source identity separate from appearance and derived groupings

A structural member can appear as a segment, a force arrow, a readout and an
equation term. Those appearances refer to one member even though their geometry
and labels differ. A view may also omit an object or show only its containing
group: the first circuit overview intentionally aggregates terminal selection
to the containing circuit block.

The editable circuit adds a stronger case. The inspected net follows a stable
terminal. Rewiring can change which other terminals belong to that net without
changing the inspected terminal. Giving a temporary net index the same lifetime
as a component would obscure that distinction.

A future reference contract needs scope/instance identity, resolution and an
explicit response to deletion or absence in a view. An SVG node or an array index
cannot supply those semantics. The prototypes demonstrate local policies; a
common reference/selection implementation still needs design.

### 2. Treat geometry, layout and routing as separate responsibilities

The circuit has three distinct kinds of information:

- Electrical connections: explicit pairs of terminal IDs.
- Drawing placement: component positions in a separate presentation store.
- Wire paths: SVG geometry computed from the current terminal positions.

The structure's joint coordinates instead enter its physical equations. A shared
interaction layer therefore cannot assume that all dragging is a presentation
edit, or that all movement should rerun domain analysis. The same applies to
history: circuit layout is currently outside electrical undo, while a completed
joint drag is one structural undo step. Those are prototype policies to make
explicit, not a requirement that all applications copy them.

The circuit's responsive routing is deliberately small. In
[dc-layout.ts](../../demos/semantic-svg-lab/src/model/dc-layout.ts), the initial
component positions are hand-authored. Dragging snaps them to a bounded 10-unit
drawing grid. Terminals are fixed offsets from their component centres. Each wire
is then independently redrawn using these rules, in priority order:

1. A wire joining terminals of the same component takes a rectangular detour
   60 drawing units to its left.
2. Other terminals with the same horizontal coordinate get a straight segment.
3. Otherwise the path uses vertical–horizontal–vertical segments. Two top
   terminals share a horizontal segment 35 units above the higher terminal;
   two bottom terminals share one 35 units below the lower terminal. Mixed
   top/bottom terminals use the midpoint of their vertical positions.

Solid updates those paths during the drag preview. There is no automatic
component-placement engine, obstacle search, global crossing minimization, bend
optimization or persistent user waypoint model. The separated-terminal view also
uses a prescribed arrangement. Awkward placements can produce overlapping or
misleading-looking paths; the explicit connection model remains authoritative.
The study does not import Analog Canvas's layout or routing implementation.

This is sufficient to test semantic editing. More capable routing would be a
separate provider, with inputs such as terminals, obstacles and routing intentions,
and outputs such as paths and routing diagnostics. A new route must not silently
change electrical connectivity. Choosing a router or implementing that provider
is deferred.

### 3. A useful lens explains a relationship

The most informative projections revealed hidden terminals, isolated the forces
on a joint, separated coincident member ends, or exposed electrical net membership.
Magnification is one possible operation; explanatory views can also suppress,
rearrange, aggregate or add derived information.

Appearance-to-source mapping must remain meaningful through those changes.
Semantic styling follows the same principle: voltage coloring and tension/
compression coloring express domain results without changing them. The examples
support this separation, but do not yet establish a general symbol-variant,
semantic-style or spatial-lens API. The existing trigger/peek/detail `Lens` remains
a different attention component from a movable spatial lens.

### 4. Distinguish mathematical facts, unresolved quantities and design goals

A numerically solvable circuit can still fail its task. Opening the return gives
a defined 12 V output with no source current, instead of the intended loaded
6 V output. A passive floating resistor has unknown absolute terminal voltages,
but its voltage difference and current are zero in this restricted DC model.
The referenced divider can remain solved while that island is unreferenced.

The structure demonstrates different limits: an infinitesimal mechanism can be
compatible with a particular load without establishing stability; equilibrium
alone cannot select unique member forces in an indeterminate structure. Its
current implementation conservatively withholds the whole member/reaction
solution in those cases. That policy is not the final model for partial results.

The shared layer should be able to present known, approximate, unresolved and
inconsistent quantities without deciding their mathematical status itself.
Assumptions, residuals, precision policies and diagnostic targets belong to the
analysis provider. Domain design rules, numerical validity and visual problems
such as label overlap may share a diagnostic presentation, while retaining
separate checks and meanings.

The contact experiments likewise rely on a restricted shape/parameter universe.
They do not establish a general exact geometry kernel, robust arbitrary-curve
contact, rolling, sliding or dynamics.

### 5. Targeted diagnostics are part of editing

A finding becomes actionable when its targets can be selected in the drawing
and inspected through another view. The two studies now share
[TargetedDiagnostic](../../demos/semantic-svg-lab/src/semantic/diagnostics.ts) and
[TargetedDiagnostics](../../demos/semantic-svg-lab/src/ui/TargetedDiagnostics.tsx).
The presenter receives a title, explanation, opaque references, label resolution
and a selection callback. It knows neither circuit terminals nor structural
members.

This is concrete reuse across two schemas. It establishes a small presentation
boundary, not a reusable rule engine, automatic repair planner or common domain
ontology. Whether the explanations let a new user repair a design unaided remains
an open usability question.

### 6. Share domain operations across input methods

Pointer gestures, inspector edits and tool calls ultimately use the same domain
edit operations. A meaningful gesture needs a preview, a commit boundary,
cancellation and an appropriate undo unit. Inspector drafts and scripted
proposals retain a revision precondition so an intervening edit cannot silently
change the context of the requested operation.

The circuit and structure command vocabularies remain different. A generic layer
could carry operation descriptions, affected references, preconditions and preview
results without owning the commands themselves. Coarse revision guards are enough
for these studies; dependency-scoped conflicts, multi-writer merging and durable
project history have not been established.

### 7. Separate ink evidence, object attachment and interpretation

The Pencil toolkit supplies real stroke input and capture. A frozen request keeps
its source view and ink available for review; later edits do not rewrite that
original evidence. The early markup experiment also tested a different behavior:
marks with a clear inverse projection can follow a selected object. Evidence
capture and attachment have different coordinate and lifetime requirements.

The two editing studies share
[PencilCapturePad](../../demos/semantic-svg-lab/src/ui/PencilCapturePad.tsx), a local
adapter around the existing toolkit. Their proposed operations are scripted and
named before drawing. This tests capture, consequence previews and guarded apply;
it supplies no evidence that an AI can infer a good edit from ambiguous marks.
Simultaneous voice/pencil use and fluid interpretation remain separate work.

### 8. Prefer complete tasks over more variations of the same gesture

The early scalar examples became repetitive once shared controls and linked
highlighting worked. Topology editing forced more consequential questions:
which identities survive, which quantities cease to be known, how a diagnostic
leads to inspection, and how an edit can be reviewed and undone.

Future experiments should name the unresolved question and the behavior that
would answer it. Preserve useful fixtures, mathematical tests and interaction
evidence; expect to replace application scaffolding when it stops helping.

## What is shared, and what remains a hypothesis

| Area | Evidence at this stopping point |
| --- | --- |
| Reactive substrate, scopes, actions, HMR, controls, numeric gestures, RichTeX and Pencil | Existing AIUI infrastructure reused by the studies. There is no reason to recreate these inside an SVG package. |
| Targeted diagnostic presentation and fixed-plane Pencil capture | Actual shared adapters, still local to this lab. |
| Reference resolution, selection/reveal, projection mapping and edit/proposal lifecycle | Repeated useful patterns, mostly wired independently. A common implementation is still a hypothesis. |
| Symbol libraries, physical/electrical rules, solvers and domain edits | Application responsibilities. They may become separate domain packages if useful. |
| Placement, routing, animation and semantic style providers | Boundaries suggested by the studies; general implementations and APIs remain open. |

The best current architecture hypothesis is a small coordination layer over domain
adapters and the existing toolkit. Its responsibilities would be to resolve scoped
references, associate appearances with those references, coordinate attention,
present findings and carry edit/evidence context. The domain would supply meanings,
relationships, computations and operations. This is not a settled API, package
split or universal document schema.

## Resume criteria and stopping point

The user has reviewed the circuit and structure studies and asked for this
consolidation. This closes the current exploration. Keep the prototypes available;
do not start another lab, extract a public package or expand the physical models
as part of this task.

If the work is resumed, the highest-value questions are:

1. Can one reference/appearance/selection mechanism serve both existing studies,
   including derived net membership, missing appearances and deletion, without
   changing either domain schema? This would be a better next integration test
   than adding a third domain.
2. Can a real agent use bounded object/relationship queries, diagnostic targets,
   source revision and captured evidence to propose an edit through these existing
   operations? Test interpretation separately from the already scripted workflow.
3. Which authoring requirements actually demand richer symbol families, routing,
   annotation attachment or animation? Choose a specific task before choosing
   algorithms or package boundaries. Presentation animation must not imply a
   physical trajectory or precision that the domain computation does not supply.

The observations above justify retaining the interaction direction. They leave
large-document performance, storage/interchange, richer libraries and rules,
mathematical kernels, accessibility beyond the checked interactions, and sustained
human/agent collaboration open. Those are future requirements to investigate when
there is a reason to resume, not unfinished promises of the current mockups.
