# Shapes checked against the sites' corpus

The files below are read-only requirements evidence. They are not golden outputs for this package,
and this work neither imports a legacy renderer nor migrates an existing caller. Synthetic fixtures
exercise the shapes with different content and deliberate escaping/ownership edge cases.

| Evidence | Foundation contract |
| --- | --- |
| [All markers](../../aiui-lowering-pipeline/corpus/all-markers.txt) | Ordered Group/Prompt/Join composition, structured Marker children, XML sidecars, explicit asset identity/reference policy |
| [Existing span map](../../aiui-lowering-pipeline/corpus/all-markers.spans.json) | Exact primary contribution partitions plus captured event/selection/source origins; `importText` for opaque inputs moving later |
| [Tool brief](../../aiui-viz/corpus/tool-brief-seismos-like.txt) | One ToolSnapshot, read/write/other and group projections, preserved declaration and field origins |
| [Budgeted brief](../../aiui-viz/corpus/tool-brief-seismos-like-900.txt) | Retained full declarations, longest-usage-first policy and recorded removals, explicit required-over-budget result |
| [Delegation](../../aiui-live/corpus/claude-delegation-message.txt) | XML wrapper containing transcript lines, a structured request, Markdown sections, and ToolBrief without flattening author-side |

The new contribution map covers every emitted character and every media part, including ordinary
prose and generated delimiters. It does not infer ownership by scanning for the old bracket strings.
A shot marker and its XML metadata can share a parent with a captured-event origin while retaining
independent child ownership. A tab XML node can be a child inside a Marker, so its attributes remain
structured. An unknown asset is an explicit missing binding error at lowering; an application that
wants an unavailable-asset notice should record that branch with Case.

`importText` provides a narrower migration path for an existing offset-annotated string. It copies
exact text and disjoint span origins into ordinary semantic Text nodes, including metadata supplied
by the host. Uncovered prose retains a parent origin. This is explicitly opaque input, not a claim
that the old string has become a parsed semantic marker/XML document. New compositions can replace
those opaque pieces one at a time.

Inside XML, ordinary Markdown/TeX/tool text is escaped exactly once; nested Xml stays structural.
Elision selects logical content before XML escaping and records that scope. Tool budget counts
likewise describe the projection before XML escaping. Final accounting always measures actual
emitted output. This separates two questions: what the author chose to retain, and how much the
encoded document ultimately contains.

Marker spelling, attribute order, empty-element spelling, whitespace, and wording need not match the
baseline. A later caller migration must review its actual output differences, including any change
to prompt meaning. These fixtures establish expressiveness and ownership, not behavioral quality
of an LLM's response.

The workbench on port 5219 has synthetic delegation and marker/sidecar examples alongside the
scientific example. XML tags remain inert literal markup. CommonMark may recognize Markdown/math
blocks between them; a whole XML block may also remain literal. Recognized math wholly inside a
compiler XML region decodes one text-escaping layer for display, while keeping its original encoded
range and whole-equation navigation. Tree/raw navigation, contributions, folds, and budget decisions
remain available. General nested XML preview and decoded-character navigation need additional maps.

The [consumer review](../../../docs/proposals/structured-prompts-review.md) and
[site survey](../../../docs/proposals/prompt-sites.md) remain the authority for downstream adoption
order: shared tool brief, oracle/live, lowering/channel, then small page-authored tool text. This
foundation adds consumer-owned adapter contracts and utility profiles; transport implementations
and caller-specific policy stay with those consumers.
