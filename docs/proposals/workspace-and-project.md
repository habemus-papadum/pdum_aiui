# Workspace and project: the hypotheses ledger and the loop

Status: exploration, 2026-10-17. Two rounds of repeat-back between the owner and the agent, a mock,
a reading guide, and the owner's notes on it. Nothing is built. This file is the ledger of bets we
will build to, and the loop we will use to build, test, and rebuild them. It is deliberately not an
architecture. The first application has not been chosen; the owner is deciding.

Beside this file: [`workspace-and-project/mock.html`](./workspace-and-project/mock.html) is the
interactive mock (iteration 2: stations at three rungs, four layout rules, a four-view workflow,
a phase control, the project tree, the lifecycle, writers and watchers, what is saved where, the
prior-art shortlist, and where the questions stand) and
[`workspace-and-project/reading-guide.html`](./workspace-and-project/reading-guide.html) is the
reading and viewing guide to the prior art, every link verified on 2026-10-17. Both are plain HTML
and open from disk; the published copies are at
<https://claude.ai/artifact/VwJFj1KgisWYadsW3s5LVm> and
<https://claude.ai/artifact/BXbrHtgnCsSrkSpdLTLxLt>.

Related records, to cite rather than re-derive: the
[three-applications proposal](./three-applications-and-development-process.md) (the mathematical,
circuit and prompting applications, the development method, the capability inventory C01–C13), the
[agentic patterns proposal](./agentic-patterns-and-use-cases.md) §9 and §10 (history, storage,
forking; event streams into Solid), the [semantic SVG proposal](./semantic-svg.md) (where lenses
now go), and the [catalog](../../packages/aiui-viz/CATALOG.md) (what exists, and the extraction
rule in §6).

## 1. The vision in one paragraph

A **project** is a tree of heterogeneous design data with a history along time and **variations**
side by side; it is the interface to the outside world (simulators, renderers, compilers, printers)
and is edited concurrently by a human and by several agents, some of them writing straight to the
store. A **workspace** is a flat 2-D surface of **stations**, each a view into the project rather
than a node of it, each at a **level of detail** that sets both its size and its compute, arranged
by **layout rules** into **views** that a **workflow** orders, with plain text **guideposts** and
**leaders** between stations. A **lifecycle** runs over both, from sketchbook to refinement and back
by markup, and the phase decides how strict everything is. The owner is the design lead; the agent
is the technical architect and the engineering staff. Built for one person, agent-first primitives,
ordinary HTML and CSS.

## 2. Decisions already taken

These are settled for now and are not in the ledger below.

- **Station** is the word. Kitchen names (the pass, a ticket) are welcome, lightly.
- **Lenses live in `aiui-svg`, not in the workspace.** The magic lens that re-renders what is under
  it, including the one that pushes parts apart to show boundaries, is a different projection of the
  same document under the glass. That makes a lens a small local view and a station a large one.
  The workspace needs only the rungs and a way for a station to host a lens; the lenses themselves
  are SVG components (owner, 2026-10-17).
- **Size and detail decide each other in both directions**, with iteration; a rule proposes, a view
  may pin, a station may ask.
- **A sparse planning arrangement is a real view.** Layout need not fill the surface.
- **Text and HTML guideposts** live on the surface beside stations and are not stations.
- **Leaders are both**: free-form early in the lifecycle, typed later, and the refinement is itself
  worth recording.
- **The lifecycle is first-class**, gates strictness and available states, and runs backwards as
  well as forwards.
- **Deferred until built**, by the owner's instruction: the exact shape of a variation set and
  whether a current pick exists, conflict resolution between writers, and the exact phase names.
  The ledger states a working bet for each so that a slice can be built; the bet is not a decision.

## 3. The hypotheses ledger

One bet per open question. Each row says what we will build to, which prior art it borrows from,
what would make us abandon it, which application should test it first, and how expensive it is to
reverse. Rows are numbered for citation; the numbers are stable, the text is not. When a slice
confirms or refutes a row, the row gets a verdict line with the slice that produced it.

Reversal cost: **cheap** means a slice can swap it without touching others; **dear** means the
project format or the store changes with it.

### The project

**H1 · The first store is a git repository of files, one node per file, and the project model never
assumes it.** The model is a tree of typed nodes addressed by path; the store is a pluggable
adapter whose contract is read, write, list, and a change feed. Borrows from: Onshape's document
owning its history, inverted (we let git own history first because it is free). Falsified if: the
first two applications each need a per-node operation git cannot express (a sweep over a
variation set is the likely one) and we find ourselves encoding structure into filenames. First
test: slice one, whatever it is. Reversal: dear.

**H2 · The change feed is a version counter plus a list of touched paths, the same shape over every
store.** The workspace subscribes once; a station's cells re-run when a path they read is touched,
whoever touched it. Borrows from: the dev server's module graph invalidation, applied to content.
Falsified if: an agent editing many files at once makes the feed useless without transactions, or
a store cannot give touched paths cheaply. First test: an agent editing the project from the
filesystem while the workspace is open. Reversal: cheap.

**H3 · A variation is an overlay of deltas over one base node, a variation set is the named list of
overlays, and "current" is the empty overlay.** Nothing is copied; a candidate is base plus delta.
Borrows from: Houdini takes (layered parameter overrides, inherited from the parent take) and
Altium variants (one base, fitted or changed per variant). Falsified if: the domains' candidates
differ structurally rather than parametrically, so a delta is as large as the node and the overlay
buys nothing; then Onshape's configuration table or Final Cut's slot-with-a-pick replaces it.
First test: weave variants (parametric, should fit) and then a circuit topology change (may not).
Reversal: dear.

**H4 · A sweep is a product over variation sets, declared as one node, run outside the browser, with
every result stamped by the parameter values that made it.** Borrows from: Houdini wedging (one
declaration generates the work items; results carry attributes; downstream nodes read all variants
uniformly) and Cadence corners (the matrix as a first-class object with a result per cell).
Falsified if: results stamped by parameters are not enough to compare them and we need a sweep
to own its own layout of results; or if sweeps are rare enough that a script suffices. First test:
weave variants by palette by sett, rendered as a contact sheet. Reversal: cheap.

**H5 · Derived nodes carry a recipe and the version of every input, and a result that came back from
outside is a derived node too.** The queue of jobs out and results back is a node in the tree.
Borrows from: our own cells (a derived value with its dependencies), Fusion's timeline (intent kept
beside result), and the circuit proposal's rule that an old chart must not describe the current
circuit. Falsified if: stamping every result with input versions makes the tree churn so much that
history becomes unreadable; then results move to a sidecar keyed by version. First test: the render
queue in weave, then simulation results in circuits. Reversal: cheap.

**H6 · History is the store's graph plus a dependency graph; it is not a replayable program of
edits.** We keep what each derived node depends on and let the store keep versions; we do not keep
an edit log as the source of truth. Borrows from: Fusion's parametric timeline as the thing we admire
and decline, because its replay fragility (references breaking when an early step changes) is the
cost of making the edit log authoritative. Falsified if: regress-by-markup turns out to need true
replay of the human's edits rather than a new version plus a record. First test: the first regress
in any application. Reversal: dear.

**H7 · Writers resolve by last write per node, with the station re-reading on the change feed; no
locks, no merge.** Borrows from: Figma's per-property last-writer-wins, argued as the simplest
thing that holds. Falsified if: a human mid-edit on a node loses work to an agent more than rarely,
or two agents on one node become common; then the eventually consistent store (Automerge, as in
Patchwork) replaces git for the nodes that need it. First test: an agent and the owner editing the
same weave within a minute of each other. Reversal: dear if the store changes, cheap otherwise.

**H8 · Spikes are branches on the history axis that carry a chosen variant forward; they are not a
third kind of thing.** A spike is "branch, pin variation set X to candidate B, proceed"; merging back
is a decision at the pass, not an automatic merge. Borrows from: Onshape branches as pointers into
the document's version graph, and the way a software spike works in practice. Falsified if: a spike
regularly needs to live beside the main line in the same view, which a branch makes awkward; then it
becomes a variant of the whole project. First test: the first "try only B" in weave. Reversal: cheap.

### The workspace

**H9 · Three rungs of detail, icon, card and full, where the icon is drawn from the data by the
station's kind and never stored as an image.** Each rung has a compute budget: cached, light, live;
a station off the view runs nothing. Borrows from: Pad++ semantic zoom (the object owns its
renderings per scale), the lens's trigger-peek-open ladder already in `aiui-viz`, and the card and
page split of the gallery. Falsified if: two applications both want a fourth rung in the same place,
or if continuous magnification turns out to be wanted at the workspace level after all (the owner's
bet is that it belongs to SVG). First test: the weave's icon, card and full renderings. Reversal:
cheap.

**H10 · A layout rule is a pure function from an ordered list of stations and a rectangle to
rectangles, and the rung follows from the rectangle unless the view pins it.** Rank comes from the
view (hero first, then named cards, then the rest). Borrows from: xmonad's layouts as values of one
type, dwm's master area, and Furnas's degree-of-interest as the formula behind a rule that is not
hand-placed. Falsified if: a rule needs to know the station's content to size it well (a wide plot
versus a square swatch), in which case the function takes a size hint per station and the "pure"
claim weakens but survives. First test: hero plus rail and the sparse plan rule over the same
stations. Reversal: cheap.

**H11 · A view is a set of stations with ranks, pins, guideposts and leaders, saved as one file; a
workflow is an ordered list of views; a station appears in several views with its own rank in
each.** Borrows from: Rooms (one window, a placement per room, doors between rooms, an overview),
Blender's workspaces as tabs of areas, Freeform's scenes as named framings. Falsified if: views
turn out to be mostly generated (by the agent, per task) rather than saved, in which case the file
is a cache and the workflow is a prompt. First test: the four-view fabric workflow of the mock,
made real. Reversal: cheap.

**H12 · The workspace layer is a folder inside the project (`.workspace/`), one file per view, versioned
with the project but readable by nothing else; a third layer, the session, is never saved.** Borrows
from: Blender keeping workspaces in the file but separable, and git's own `.git/` as a precedent
for a dot-folder a tool owns. Falsified if: offline tools keep tripping over the folder, or if
sharing a view across projects becomes common; then views move to a sibling repository or a
registry. First test: the first offline script over a project. Reversal: cheap.

**H13 · A station is of a kind, the kind owns its three renderings and declares which node types it
can read, and kinds are the unit that moves into the library.** A station instance is a kind plus
a binding to nodes (paths or a query) plus a rank in a view. Borrows from: Blender's editor types,
OpenDoc's parts with their editors, and the catalog's rule that a piece is promoted by extraction
once a second page wants it. Falsified if: most stations are one-offs with no second use, in which
case the library holds the rungs and the binding and nothing else. First test: the second
application reusing a kind from the first (the text station, most likely). Reversal: cheap.

**H14 · Leaders are a view's data until the lifecycle types them, and a typed leader is a project
edge.** A free-form leader is a line between two station regions saved in the view; promoting it
writes a relation into the project and the view keeps a reference. Borrows from: Houdini's wired
networks as the typed end state, FigJam connectors as the free-form start. Falsified if: typed
leaders are rare in practice and untyped ones are all anyone draws, or the reverse. First test: the
first mock-to-build transition in any application. Reversal: cheap.

### The agent surface

**H15 · The agent works through a small set of generic verbs over typed nodes (read, write, list,
derive, vary, sweep, promote) plus one verb per kind, and reads a view as "the nodes in focus plus
the guideposts," not as geometry.** Borrows from: the Xerox Star's universal commands over typed
objects with property sheets, Genera's presentations (what is drawn stays typed and addressable),
and our own `report` and `set` tools. Falsified if: agents keep needing the arrangement itself (what
is next to what) to do the work, in which case the view's geometry becomes part of the brief. First
test: an agent asked to "make the drape believable" from the Cloth view alone. Reversal: cheap.

**H16 · Every station is addressable after it is drawn: its root carries the kind, the nodes it reads
and its rung as stamps, and `read-page`, `selection` and `locate` know them.** Borrows from: our
existing stamps and readers (`data-cell`, `data-control`, `data-tex`) and the catalog's rule that a
piece an agent cannot read back is half a piece. Falsified if: never; this is the house rule applied.
First test: slice one. Reversal: cheap.

### The lifecycle

**H17 · Phase is a property of a node, inherited down the tree, with the project's root carrying the
default; a mock-phase node can sit beside a refined one.** Borrows from: NASA readiness levels, which
are assessed per technology rather than per program, and architecture practice where a detail can be
at construction-document precision while the site plan is still schematic. Falsified if: mixed phases
in one view confuse more than they help, in which case phase becomes per project with per-node
exceptions. First test: the first partial regress (mark up one station's node, not the whole).
Reversal: cheap.

**H18 · A phase is a label with a lint level attached, not a gate with written criteria, until an
application shows that a gate pays for itself.** Lint off, advisory, strict; the available states of
a kind are filtered by phase. Borrows from: the AIA phases as practice (precision per phase) rather
than NASA's reviews (criteria per gate), because a gate is chrome built early. Falsified if: the
owner asks "is this ready to advance" often enough that criteria would save time. First test: the
first mock-to-build transition. Reversal: cheap.

**H19 · Markups live in the workspace layer as ink and notes anchored to nodes, and a markup becomes
a project node only when the agent answers it.** The exchange, the rough-out and the implementation
that answered it, is the lifecycle record, a log of its own beside the project and the workspace.
Borrows from: redlining in architecture, where the markup is a layer on the drawing and the
resubmission is the new drawing; Fusion's timeline as the "record with replay" we are not building
(H6). Falsified if: markups need to be versioned and diffed like design data, in which case they are
project nodes from the start. First test: the first regress by markup. Reversal: cheap.

### What is right today

Three places where 2026 changes the older answers, kept here so the ledger does not drift back to
the builder's-hands versions.

- **Sweeps are cheap to run and expensive to represent.** A cloud or a farm runs two hundred variants
  as easily as one, and an agent writes the wedge. The representation (H3, H4) is the work; the
  scheduler is not ours.
- **Documents can merge by construction.** CRDT libraries are mature (Automerge; Ink and Switch's
  Patchwork is built on it). H7 chooses the cheap option first, knowing the dear one exists and is
  real, and names the condition for switching.
- **The agent is the primary user of the verb set.** The Star's generic commands and Genera's
  presentations described what a person needed to see and point at. We already have the pointing
  (stamps, `selection`, `locate`) and the verbs (`report`, `set`, actions); H15 and H16 extend them
  rather than inventing a second surface.

## 4. The loop

Build, use, rebuild, in Engelbart's sense: the tools are used to build the next tools, and rebuilding
is the expected outcome of using them, not a failure. The rules below are the whole process.

**Two ledgers.** This file's hypotheses ledger (§3), and an application ledger (§5) of candidate
applications scored by the infrastructure each forces against its cost. The order of building falls
out of the second; the verdicts fall into the first.

**Slices, not layers.** Each round builds the thinnest end-to-end thing for one application: a store
with a change feed, two or three station kinds, one view, one layout rule, and an agent editing the
project from the filesystem while the workspace is open. No layer is finished before the next begins.
Everything is pre-alpha; scaffolding is replaced, not patched.

**The pass.** A slice ends with the owner at the pass. Each hypothesis the slice touched gets a
verdict: **kept**, **rebuild** (with what changes), or **dropped** (with what replaces it), written
into §3 with the slice's name. A slice that produces no verdicts was too thick or too thin.

**Bootstrapping.** The two ledgers are the first project: a tree of markdown and yaml files, a view
of text stations and guideposts under the plan rule, phases on the rows. It is the cheapest possible
test of H1, H2, H9 on text, H11, H12 and H17, and it means the workspace is in use from the first
week. It is weak on H3, H4 and every visual kind, so it is never the only slice in flight.

**Extraction.** A kind, a rule, or a store adapter moves from an application into `aiui-viz` (or a
sibling package) when a second application wants it, and not before. The catalog row is written in
the same commit, with its state.

**The record.** This file is the record. Verdicts go into the ledger rows; retired bets stay in the
file with their verdict, not deleted, until the whole proposal retires into a design document and
git history. A separate list at the end of §3 is not kept; the rows are the list.

**What the loop does not do.** It does not schedule. It does not require the three applications of
the earlier proposal to be built in that order or at all. It does not pick a first application; the
owner does, and §5 is where the candidates and their scores go when that conversation happens.

## 5. The application ledger

Empty by design until the owner chooses where to start. Each row will carry: the application; the
store it needs; the station kinds; its variation axis; its outside-world interface; which lifecycle
phases it exercises; whether it wants a loupe (and therefore `aiui-svg`); which hypotheses it tests;
and a cost. Candidates named so far, in no order: the plan itself (the bootstrapping slice), the weave
and fabric example of the mock, the VACASK circuit workspace, the mathematical workspace with Lean,
and the optics and oscillator notebooks already in the repo as sources of pure models.
