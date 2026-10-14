# Three applications and an adaptive development process

Status: proposed application scope and development methodology, 2026-10-14.
This is the master proposal for three applications and the process for building
them. Detailed application specifications and an implementation sequence will
follow; no first implementation step is selected here.

Build three applications to give the related AIUI and agent-tools work a concrete
direction:

1. A pencil-and-voice mathematical workspace for documents, calculations, proofs,
   and linked Lean 4 formalization.
2. A circuit design and analysis workspace built around rapid iteration with
   VACASK.
3. A multimodal prompting and agent operations tool that grows into session
   monitoring and analysis across runs.

These applications provide working contexts for developing the libraries. They
bring together agent clients, structured prompting, pencil and voice, semantic
SVG, companion interfaces, and observable agent execution. Applications may live
in this repository or in separate repositories consuming the libraries; their
final homes and packaging remain open.

## 1. Development method

### Use the applications to organize substantial, reusable work

The applications are useful destinations and a way to make infrastructure
decisions concrete. None is currently a mission-critical delivery with a fixed
deadline. We can invest in a component's design, generality, and reliability when
we reach it, including capabilities beyond what these three applications need.

The goal is to implement interconnected components coherently and exercise them
in real workflows. An implementation step may deepen a shared library, resolve
a design question through a spike, integrate several existing pieces, or advance
an application. It should have an understandable outcome and a point at which
we can review what we learned.

Existing partial implementations are a normal starting point. Use the available
pieces, inspect their actual contracts, and improve them as the work develops.
The applications can progress while other capabilities remain unfinished. Broader
ambitions stay recorded even when the current application work does not exercise
them.

### Keep three levels of planning detail

| Horizon | Detail and purpose |
| --- | --- |
| Overall direction | A small number of very coarse steps, perhaps around ten, showing how the applications and shared infrastructure could develop. The count and order can change. |
| Immediate step | Concrete outcome, scope, design decisions, dependencies, parallel work, integration responsibilities, and evidence needed for review. |
| Likely following step | Moderate detail: a plausible outcome, important dependencies, and questions the immediate step should help answer. |

Later work remains broad until there is enough evidence to size it. The initial
plan should preserve the global picture without specifying every future task.
An immediate step can contain several substantial tasks and parallel agent work;
its size should be calibrated through experience.

### Execute, review, and resize

For each step:

1. Define the concrete outcome and which application workflows or library
   capabilities it advances. State any deliberate investment in broader
   generality, along with the step's boundaries.
2. Divide independent work into parallel tasks where useful. Give agents clear
   ownership, shared contracts, dependencies, and a place to integrate their work.
3. Implement and integrate the result. Exercise the affected workflow and perform
   checks appropriate to the changes. Record what works, what is partial, and
   what the evidence does and does not establish.
4. Review the result with the human. Was the step too small, too large, or aimed
   in the wrong direction? Did the experience reveal a different architecture or
   a more valuable next outcome?
5. Resize or replace the next step, revise the coarse plan, and update the
   capability inventory and deferral record. Then make the next immediate step
   concrete.

Changing direction, abandoning an approach, splitting a step, or combining work
are expected outcomes of review. Parallel work should produce an integrated,
reviewable result; completion of separate agent tasks alone does not establish
that the application workflow works.

A step description should record its intended outcome, relevant proposals,
starting capabilities, scope and exclusions, parallel tasks, integration owner,
validation, and review questions. Its completion note should capture the result,
lessons, newly discovered work, explicit deferrals, and the revised next step.
These records can be brief when the work is simple.

## 2. Mathematical workspace

### Intended experience

A web application helps a person write mathematical documents, develop proofs,
and perform calculations while collaborating with an open-ended agent such as
Codex or Claude Code. Pencil and voice are primary inputs. The person can begin
with a problem, say "Let x be a real number," write a few lines of a proof, and
continue explaining the argument aloud.

AI interprets the handwriting and speech together with the document context,
turning them into mathematical content and LaTeX. An editing flow lets the person
correct the interpretation, revise notation, reorganize the argument, and
continue writing. The source ink, audio or transcript, and resulting content
need enough association to understand and correct the conversion; their exact
retention and editing behavior will be specified later.

The main display can show the organized document, formalization status, and
agent activity while a companion offers a writing surface on a pen display or
tablet. The same workflow should also be useful directly in the main web app.

### LaTeX, Lean 4, and their correspondence

The project contains a mathematical document, Lean 4 statements and proofs, and
an explicit correspondence between them. The intended system is inspired by a
Lean blueprint but will have a richer synchronization and correspondence model.
Its exact design remains to be described.

The interface should make several questions separately visible:

- Has a statement in the LaTeX document been formalized in Lean 4?
- Does the linked formal statement still correspond to the current exposition?
- Has its proof been completed and checked in Lean 4?
- What needs attention after the document, statement, or proof changes?

Checking a Lean proof establishes a fact about the formal statement that was
checked. The correspondence with the intended informal mathematics is a separate
part of the workflow. Status should retain that distinction and identify the
revisions to which it applies. The mechanisms for expressing correspondence,
reviewing equivalence, and invalidating outdated status remain design questions.

### Human and agent work on the same project

Speech and pencil interpretation is the especially AI-specific part of the
experience. Editing LaTeX, editing Lean code, maintaining their correspondence,
and running formal checks should also be possible through ordinary human work.
Those activities should not require an agent to keep the project usable.

An agent can perform the same project work on the person's behalf. For example:
"Derive a proof of this lemma in LaTeX, formalize it in Lean 4, and check it."
The task may involve reading files, changing code, running tools, inspecting
errors, and iterating. This is an open-ended coding and mathematical workflow,
with the human able to edit the same artifacts and steer the agent as it works.

A representative loop is to write and explain an argument, refine its LaTeX,
ask the agent to develop or check a selected part, inspect the result and its
formalization status, and continue the document. Calculations belong in that
workspace as well; the choice of calculation tools remains open.

### Questions for the detailed specification

Define the mathematical document's editable units, the blueprint-like linking
model, the meaning and freshness of each status, and the editing flow for
interpreted input. Decide how direct file edits and browser edits become visible
to one another, how Lean runs are managed, and how the user reviews agent changes.
These choices should preserve both manual and agent-assisted operation.

## 3. Circuit design and analysis workspace

### Intended experience

Build a rich, interactive frontend specifically for the VACASK Verilog-A
simulator. Its target scope includes the simulator's range of analyses,
parameter sweeps, and parameters expressed using supported algebraic expressions.
The detailed specification will map those capabilities to concrete controls and
workflows using VACASK's own semantics.

The central loop is continuous design and analysis. A person draws part of a
circuit with components, pins, and connections, runs an analysis, sees the
results beside the circuit, and changes the design in response. The application
should make this loop fast enough to use throughout construction and exploration.

Charts and analysis items belong near the circuit and remain interactive.
The person can inspect a result, adjust a parameter or connection, request a
different analysis or sweep, and compare what happens. Expression-based
parameters should remain meaningful editable expressions in the circuit and
analysis model rather than disappear into a single evaluated number.

### One structured circuit, several ways to edit it

The circuit has a structured representation with component identities,
parameters, pins, and connectivity. Semantic SVG provides an interactive diagram;
pencil adds sketching, annotations, and proposed changes. The application defines
how input becomes a circuit edit.

Direct manipulation, parameter controls, programmatic changes, and agent tool
calls should operate on the same circuit model. A human can change an agent's
result and continue working with it. Shared editing and undo behavior should
make those changes understandable and revisable.

Each analysis needs a relationship to the circuit revision, parameters, and
analysis configuration that produced it. Continuing to edit should not make an
older chart appear to describe the current circuit. How to retain, compare,
refresh, or replace results is part of the application design.

### Agent-driven iteration with human steering

The agent can drive much of an optimization or exploration loop. Given an op amp
design goal, it might modify the circuit, run analyses and sweeps, examine the
results, and choose another change. The human watches the circuit and results,
contributes edits, and steers the ongoing work: "Try this configuration," "Keep
that component fixed," or "Explore this parameter instead."

The interface should support pausing or interrupting work and redirecting it,
with clear feedback about whether the agent received the correction and what
simulation work remains active. Circuit editing, simulator execution, and agent
turns have related but distinct lifetimes.

This application exercises the full intended analysis workflow over time.
Individual steps can concentrate on particular analyses while the broader
VACASK capability inventory remains visible.

### Questions for the detailed specification

Define the initial circuit examples, component and model representation,
parameter-expression handling, and the analysis/sweep interface. Establish where
VACASK runs, how jobs and results reach the browser, what rapid iteration means
in representative workloads, and how human edits interact with ongoing agent and
simulation work. The execution location is still open.

## 4. Multimodal prompting and agent operations tool

### Compose, refine, and deliver

The tool connects to agent backends and app servers on the local machine, remote
machines, or cloud infrastructure. The person chooses an agent and working
session, dictates a prompt, captures screenshots, collects selections, and
pastes supporting material. Pencil annotations can clarify visual references.

An editing mode lets an AI helper clean up transcription, improve clarity,
reorganize instructions, and refine the relationship between text and attachments.
The person can also edit directly. The editing helper and the destination agent
remain separate roles, so refining a draft does not implicitly submit it.

All input uses the shared structured prompting toolkit before delivery. A
single dictated block can have coarse structure; a rich draft or a request
assembled by a higher-level system can retain finer structure. The user can
inspect the prompt and the evidence of what was sent to the selected backend.

The interface can also support casual live voice delegation, interleaved with
detailed drafting and direct steering. Existing audio routing should coordinate
which system receives microphone input while preserving the other modes' state.

### Operate and follow work

Alongside sending prompts, provide tools for seeing what agents are doing,
following their sessions, and interacting with their working environments. Remote
commands and related workspace operations are part of that direction. Their
state and lifetime should remain distinguishable from the agent conversation.

The tool should grow into a workspace for following a selected session over time:
open its history, join ongoing work, inspect activity, supply further information,
answer questions, and continue or fork where the backend supports it. Moving
between backends should expose relevant capability differences.

The longer-term scope includes statistics across many runs, cost and usage
analysis, trace inspection, and notifications about work that may be stuck or
degrading in performance. Such signals should identify their evidence and gaps.
A slow operation, a disconnected observer, and an agent making no useful progress
are different conditions. Define useful measures of degradation through actual
workflows rather than assuming one universal health score.

### Interface forms

A compact Electron utility is one useful form: quick invocation, little window
decoration, rich capture, and direct delivery to agents. A standalone website,
an embedded panel, a companion, and a Chrome extension can reuse its components.
The first host environment will be selected during implementation planning.

The long-term experience needs both compact proof of life and room for a
persistent transcript, along with a separate level of detail for forensics
across sessions. The [agentic patterns proposal](./agentic-patterns-and-use-cases.md)
defines those visibility levels and the shared usage-accounting requirements.

### Questions for the detailed specification

Choose the first host, backend, and representative prompt. Define draft editing
and submission, session selection, remote workspace tools, and how an individual
session becomes a durable workspace. Develop cross-run statistics and health
notifications with explicit observation coverage and useful user-facing actions.

## 5. Shared infrastructure and application boundaries

The applications should use common components while keeping domain meaning in
their own models and tools.

| Capability | Mathematical workspace | Circuit workspace | Prompting and operations tool |
| --- | --- | --- | --- |
| Pencil and multimodal capture | Handwritten mathematics and spoken argument | Sketches, annotations, and circuit context | Screenshots, selections, and annotated prompt material |
| Structured prompting and inspection | Mathematical tasks, context, and formalization requests | Analysis requests, circuit context, and steering | User drafts, system-generated requests, and inspection of submissions |
| Shared editing | LaTeX, Lean, correspondence, and interpreted input | Circuit structure, parameters, and analysis setup | Drafts, attachments, and AI-assisted refinement |
| Semantic SVG | Mathematical diagrams where useful | Circuit symbols, pins, wires, interaction, and activity | Annotated visual context where useful |
| Companion support | A writing surface beside the organized document | Pen-friendly circuit and annotation views | Capture review and markup beside the prompt |
| Agent clients and tools | Open-ended mathematical and coding work | Simulator-driven design and optimization | Multiple backends, sessions, and remote operations |
| Activity and persistence | Formalization/checking activity and document history | Simulation progress, results, and design history | Session history, run statistics, health, and forensics |

Agent launchers, client protocols, and runtime control belong in
[`pdum_agent_tools`](https://github.com/habemus-papadum/pdum_agent_tools). AIUI
consumes that infrastructure through reactive adapters and reusable collaboration
components. Domain applications own the meaning of their documents, validations,
and operations. Host environments supply the relevant capture, storage, and
desktop integration.

All three applications should inherit the agentic proposal's shared behaviors:
mid-turn steering; visible tool activity; diff feedback for dictation and agent
edits; operation and session usage across modalities; and inspectable structured
prompts. Session storage and trace retention should suit each host while
preserving the identities needed to relate inputs, operations, and results.

The mathematical document, circuit, or prompt draft is distinct from an agent
conversation. Resuming or forking a conversation does not by itself restore or
fork those application artifacts. Concrete applications must define the
relationship rather than infer it from the agent's session identifier.

Follow the existing AIUI architecture when implementing shared pieces: pure
domain and reduction logic, reactive state, components, and application
composition, with deliberate ownership of durable resources. The application
work will help establish reusable interfaces without requiring a universal
document or session schema in advance.

## 6. Capability inventory and deferral record

Maintain a durable inventory alongside the rolling implementation plan. It
should include existing partial implementations, proposed capabilities, broader
ambitions, and discoveries made during execution. An item can remain in the
inventory even if none of these three applications uses it.

For each capability, record a stable name or identifier, intended outcome,
owning package or repository, relevant design and implementation evidence,
current state, remaining work, and the next reason to revisit it. Distinguish
implemented behavior, experimental evidence, and proposed design. Reassess status
when a step starts rather than treating a proposal or passing spike as proof of
a complete library feature.

The following is an initial inventory of areas to carry forward. It is not an
exhaustive implementation audit or a priority order. Their implementation
coverage and scheduling remain to be assessed.

| ID | Area to carry forward | Existing basis and work to account for |
| --- | --- | --- |
| C01 | Agent clients and runtime adapters | Agent-tools launchers and client experiments; session administration, history, live participation, steering, context, forks, and capability differences. |
| C02 | Browser-hosted agents | The agentic proposal's main-thread and worker variants, tool bridges, and compatible client-facing behavior. |
| C03 | Structured prompting and delivery inspection | Existing prompt records, operations, lowerers, and inspector; adoption across human drafts, automated requests, and all three applications. |
| C04 | Multimodal editing | Pencil, audio, STT, and screen capture foundations; shared draft editing, source associations, stable assets, and consistent diff feedback. |
| C05 | Semantic and reactive SVG | Proposed structured diagrams, expressive symbols, direct manipulation, edit history, motion, and pencil integration; retain mechanical-diagram and graph use cases beyond the circuit app. |
| C06 | Companion and peer communication | Instance pairing, responsive local views, application edit feedback, and reusable WebRTC support, including browser-to-Python/C++ possibilities beyond companions. |
| C07 | Mathematical documents and formalization | LaTeX and Lean editing, the richer blueprint model, formalization/proof status, calculations, and both manual and agent workflows. |
| C08 | VACASK integration and breadth | Circuit and model representation, supported analyses, sweeps, parameter expressions, job management, result comparison, and iterative optimization. |
| C09 | Activity, tracing, and accounting | Proof of life, persistent transcripts, tool annotations, recording, cross-modality usage, and cross-session forensics with known coverage. |
| C10 | Session and remote operations | Session organization and continuation, remote files and commands, persistence, asset access, reconnection, and different resource lifetimes. |
| C11 | Live voice and spoken feedback | Interleaved dictation and delegation, tool relay, microphone routing, Live commentary, and optional agent-triggered text-to-speech. |
| C12 | Cross-run analysis and health | Statistics, cost comparisons, evidence of stalls or degrading performance, and useful notifications. |
| C13 | Delivery environments | Web, compact Electron, embedded interfaces, companions, and extensions, with host-specific conveniences and shared components. |

An explicit deferral is a decision made during planning or execution. Record the
capability, what was deferred, why, what the current implementation does instead,
and a condition or checkpoint for reconsideration. Link that decision to the
step and the capability inventory. Keep completed, deferred, and superseded work
distinguishable so a change of direction does not silently erase an ambition.

No new deferrals are declared by this proposal. The inventory preserves scope;
future step reviews will decide what to advance, broaden, postpone, or replace.

## 7. Source proposals and the next planning pass

The master proposal coordinates the applications and process. Detailed
subsystem contracts remain in their owning proposals and package documentation.

| Source | Role in the application work |
| --- | --- |
| [Application patterns](../application-patterns/README.md) | Browser, service, desktop, and companion arrangements. |
| [Agentic patterns and use cases](./agentic-patterns-and-use-cases.md) | Agent/client separation, prompting, steering, visibility, accounting, and retention. |
| [Pencil architecture](../../packages/aiui-pencil/docs/architecture.md) | Editable ink, input, geometry, captures, and application interpretation. |
| [Semantic and reactive SVG](./semantic-svg.md) | Structured diagrams, symbols, interactions, and pencil composition. |
| [WebRTC and companion pages](./webrtc-and-companion-pages.md) | Pairing, transport, shared views, and companion input. |
| [Structured prompts](../../packages/aiui-prompts/README.md) and [inspector](../../packages/aiui-prompts-inspector/README.md) | Semantic records, delivery operations, and inspection of prompt content and submissions. |
| [Agent-tools research](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/docs/research.md) and [Codex client findings](https://github.com/habemus-papadum/pdum_agent_tools/blob/main/docs/codex-client-findings.md) | Existing evidence and open questions for client, history, remote-operation, health, and accounting design. |

The local agent-tools findings dated 14 October 2026 report completed client
feasibility spikes. They distinguish browsing saved history, joining live work,
and recording activity, and carry limitations for observation and accounting.
Use those findings when choosing client work; they are research evidence rather
than a completed general client SDK.

The next planning pass should deepen the application descriptions where needed,
assess the relevant existing implementations, and draft the coarse overall
sequence. Select and fully specify one immediate step, describe its likely
successor at moderate detail, and preserve the remaining direction and inventory.
The ordering should emerge from that assessment and be revised after the first
step's review.
