# Motivation — a personal workflow

::: info How to read this page
This is the first-person story behind the project. It is deliberately honest about being
**optimized for one person's workflow and viewpoints**. You might share every goal listed here and
still dislike this approach — that's fine, and [there's a section about that](#is-this-for-you).
For the neutral summary, read the [Introduction](./index) instead; for the technical program, see
[Prompt Lowering](./prompt-lowering) and [Frontend for Agents](./frontend-for-agents).
:::

## What I'm after

I want to rapidly create visualization software — usually of a technical or scientific nature —
using AI, in a **tight iteration loop**: ask for a visual change, see it, react, ask again. The
faster and lower-friction that loop, the better the software gets, because almost everything
interesting about a visualization is discovered by looking at it.

## How I actually work

I use Claude Code, in a terminal, as a CLI. I find it genuinely useful to be able to **interrupt**,
and I **watch the transcript as it goes**. I scan information
quickly, and it feels a bit like mining for gold: little nuggets flash by, some worth grabbing. I
also just learn a lot by watching an agent work — I love low-level tricks and details and not only 
do I see things I'd never reached for before, occasionally, I get the thrill of seeing something 
truly super-human.

In practice I have three modes of working:

1. **Hard problems** — I sit with the session and watch the transcript, interrupting and steering.
2. **Long runs** — I hand Claude Code something well-scoped and let it run for an hour or more.
3. **Swarms** — large-scale parallel work I don't inspect closely at all.

Most of my *physical time at the computer* is mode 1 — and I can only sustain a few hours of it a
day. So those hours have to count, and honestly, they should be fun. This whole project exists to
make mode 1 higher-bandwidth without giving up the thing I like about it: Claude Code stays open,
in front of me, doing its thing.

## The bottleneck is typing

I hate typing. Most of the time I'm dictating through [Wispr Flow](https://wisprflow.ai) rather
than touching the keyboard. Here is the framing that unlocks this project:

> **Wispr Flow is already a prompt-lowering system.** It takes one high-level modality — audio —
> and lowers it into clean text, with real cleverness applied to making that process less noisy.

I want the same move, with more modalities. I want to *say* "make **this** wider and give it the
same palette as **that** plot" — where *this* and *that* are things I'm pointing at, screenshotting,
or selecting in the DOM — and have a lowering layer resolve the pronouns, attach the evidence, and
hand Claude Code a prompt in the form it works best with. That's what this repo calls
[**prompt lowering**, or intent compilation](./prompt-lowering).

## What this project adds

Concretely, the project keeps the Claude Code CLI at the center — because I want to watch it — and
builds a layer above it:

- Utilities that launch Claude Code wired to a **custom channel**, so external tools can inject
  prompts into the *running, interactive* session (not a headless one).
- **Intent tools** that capture multimodal, high-level intent — the first is a browser overlay for
  the page you're developing — and lower it into agent-ready prompts.
- A set of [frontend principles and utilities](./frontend-for-agents) so the code the agent writes
  is the kind of code this loop iterates on well: reactive, inspectable, and debuggable by the
  agent's own future self.

## Is this for you?

Maybe. The desiderata — fast visual iteration, voice-first prompting, agent-written scientific UI —
are pretty common. The *approach* is opinionated:

- If you never watch transcripts and just want an autonomous app-builder, much of this will feel
  pointless — the design deliberately privileges the interactive CLI session.
- If you do live in the terminal with Claude Code, there is low-level tooling here (channel
  registry, prompt injection, session discovery) that's hard to find elsewhere.
- Either way, heed the [warning](./warning): this codebase is currently **safer to read than to
  run**. It's a fine source of parts and patterns for building *your* version of this workflow.
