# The Oracle

The **oracle** is a direct, real-time voice conversation with a model, available mid-way through
composing a briefing. Where the [prompt linter](./prompt-linting.md) is a *bystander* — it
silently accumulates your briefing and gives one advisory read when you press **lint now** —
the oracle is the *addressee*: while it is on, you are talking **to** the model, not past it.

The two are the same machinery (a live vendor session fed from the capture bus —
`archive/capture-bus-and-consumers.md`), differing only in persona, tools, and **how the
converse turn ends**:

| | linter | oracle |
|---|---|---|
| you are talking to… | the coding agent (it observes) | **the oracle itself** |
| its turn ends | the **lint now** button | **the vendor's own voice-activity detection** |
| after a reply | stays on, keeps accumulating | **loop — keep conversing** |
| the prompt | keeps building | **pauses** |
| vendor (v1) | OpenAI or Gemini | OpenAI |

## Turning it on

The `oracle` select in the config strip (`off | openai`). It rides the hello at thread-open and
also takes effect **live** mid-turn (the same control rail as the linter select). The oracle and
the linter are **mutually exclusive** — turning one on flips the other off; the illegal
combination is unrepresentable ("the journeys' XOR": a briefing is either being observed or
paused for a side conversation, never both).

## Prompt building pauses — like tweak, for the mic

While the oracle is on, the mic is addressed to it: talk segments do **not** transcribe into the
prompt (they resolve empty, with a traced `oracle addressed seg_N` marker), and nothing you say
reaches the briefing. Turn the oracle off and the next talk segment builds the prompt again.
**Send still works**: it sends the prompt as built *so far* — everything accumulated before (and
after) the oracle conversation. The oracle select survives the send, so the next turn re-opens
the conversation automatically.

Deliberate shots and selections behave normally — they land in the prompt *and* are shown to the
oracle (only the *voice* switches addressee).

## What is kept — the record, never the prompt

The oracle's session transcribes both directions itself (vendor input transcription — the STT
session is paused, so nothing double-transcribes):

- **`oracle-heard`** — its transcript of what you said;
- **`oracle-said`** — its reply (also spoken aloud, and shown as a 🔮 chip in the turn preview).

Both are **record events**: the compiler skips them in every configuration, exactly like
`linter-*` events. They exist so a useful side conversation is not thrown away — it is
chronicled on the turn, visible in the trace debugger, and available to future processing.

## Tools

The oracle may call `read_file` — the same tool, cap, and full-trace recording policy as the
linter ([Prompt Linting → tools](./prompt-linting.md)). Its calls ride `oracle-tool-call` /
`oracle-tool-result` events. Richer task tools are deliberately out of scope for v1.

## The prompt

The oracle persona, published verbatim (`ORACLE_INSTRUCTIONS` in
`packages/aiui-claude-channel/src/oracle-sidecar.ts`; a hello may override it via
`oracleInstructions`):

> You are the oracle: a real-time voice assistant a developer talks to DIRECTLY, mid-way
> through composing a task briefing for a coding agent. While they address you, the briefing
> is paused — you are a side conversation, and nothing you say enters the briefing. Answer
> their questions plainly and briefly: a few spoken sentences, no lists, no preamble. You see
> labeled screenshots ([image shot_3]) and on-screen selections ([selection sel_2: …]) they
> share. You may call read_file to consult a file before answering — verify, don't browse.
> If a question needs work you cannot do (editing files, running code), say so and suggest
> they put it in the briefing instead.

## Cost & keys

The oracle needs `OPENAI_API_KEY` in the channel process; keyless, it degrades loudly (a note +
error push) while briefing capture keeps working. Realtime conversation is billed per turn —
including the persona on every turn and the input-transcription model
(`gpt-4o-mini-transcribe`) for the record.
