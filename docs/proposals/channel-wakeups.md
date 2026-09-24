# Channel pushes that wake the model — the page-tools case

Status: **IMPLEMENTED 2026-09-15** — the push and `tools/list_changed` are gone (no flag:
there is nothing to turn on), the directory is a routing table the agent queries **per tab**
(`page_tools_list` / `page_tools_call` take the `<tab>` marker's ids or the url; each host
registers its honest ids), and the rule in §3 is the standing rule for any future channel push.
The finding below is kept as the record of why. Measured in
the transcripts of a downstream site build; the full forensics are kept with
that site.

## What happened

Two `aiui claude` sessions were open in the same project. Session A (Sep 9)
had finished its work and sat idle. Session B (Sep 14) was editing the
ciamac app and verifying each change through the Chrome DevTools MCP with the
usual cycle: `new_page` → `evaluate_script` → `take_screenshot` →
`list_console_messages` → `close_page`.

Every `new_page`/`close_page` pair in session B produced two channel pushes
in session A:

```
<channel source="aiui" kind="page-tools"> page tools changed: proposal/report, proposal/set, proposal/locate </channel>
```

Fifty-one of the 53 pushes carried that identical tool list; two said
`none registered`. The push timestamps trail B's `new_page` by 3–5 s and its
`close_page` by 2–3 s (the 500 ms debounce plus delivery). Each push is
delivered as a **user turn**, so the idle model ran a full request over its
136–149 k-token context to answer "Noted. Nothing to do on my side."

| | count | cost at Fable 5.1 rates |
|---|---|---|
| warm wakeups (context served from the 1 h cache at $0.25/M) | 51 | ≈ $0.04 each, $2.05 |
| cold wakeups after > 1 h idle (whole context re-written at $20/M) | 2 | $2.18 and $2.43 |
| **total** | **53** | **$6.66 — 21% of everything session A ever cost** |

The cold ones are the expensive shape: the first push after the cache has
expired re-writes the entire context to say nothing. An idle session with a
big context and a channel attached is a standing liability of
`context × $20/M` per hour of silence.

Note also that the pushes went to the *idle* session, not the one doing the
work: the page dials whichever channel server it finds first, so the active
session neither saw the registrations nor could use the page tools.

## Why it fires

`PageToolDirectory.signature()` (`page-tools.ts`) joins one `ns|hash` string
**per registration per connection**, without deduplication. One tab with the
proposal kit gives `proposal|h`; a second tab of the same app gives
`proposal|h,proposal|h`. That is a different signature, so opening a second
tab is a "page tools changed" event, and closing it is another, even though
`list()` already renders the duplicate as `shadowed` and the advertised tool
set never changed. The doc's promise that a reload's close-plus-reconnect
nets to nothing holds; a *concurrent* second tab is not a reconnect.

The Chrome MCP verification loop opens and closes exactly such tabs, so the
loop that the agent uses to check its own work is what wakes every other
session listening to the page.

## Proposal

1. **Dedupe the signature by content.** Build it from the *set* of `ns|hash`
   (sorted, unique), not the list of registrations. A second tab of an
   unchanged kit is then silent on open and on close. This alone removes the
   51 identical pushes above. One-line change plus a test in
   `page-tools.test.ts` ("second tab of the same kit does not fire").

2. **Stop delivering page-tools deltas as model turns.** The MCP
   `notifications/tools/list_changed` already tells the client to refresh,
   and `page_tools_list` answers the question when the agent has one. The
   channel push adds nothing the agent can act on by itself. Options, in
   order of preference:
   - default `--no-page-tools-notify` to on, keep the flag as the opt-in;
   - or deliver the delta as an **attachment that rides the next real user
     prompt** (a "pending channel notes" block), never as its own turn;
   - or at minimum coalesce: one push per quiet period of minutes, not
     500 ms, and never to a session that has been idle longer than the
     cache TTL.

3. **A rule for every future channel push.** Any push that becomes a user
   turn costs at least a full context read, and after an hour of idleness a
   full context write. So a push must be either *actionable by the model
   alone* (a prompt from the intent tool is; a tool-list delta is not), or it
   must piggyback on the next human turn. `kind: "startup"` and
   `kind: "prompt"` pass this test; `kind: "page-tools"` does not.

4. **Idle sessions.** Independently of the above, an `aiui claude` session
   that has been idle for longer than the cache TTL should probably detach
   from the channel (or the channel should stop pushing to it) until the
   human types again. Cheapest possible implementation: the channel server
   tracks the last human prompt time and drops pushes to sessions idle
   longer than an hour.

## Pointers

- `packages/aiui-claude-channel/src/page-tools.ts` — the directory as it now
  is: `list(selector)`, `tabs(selector)`, `call({ tab, … })`; no signal.
- `packages/aiui-intent-client/src/tools-link.ts` — `tabIdKey`: each host
  registers its honest tab ids.
- `packages/aiui-claude-channel/docs/websocket-protocol.md` — "The directory
  is a routing table, not an event source" and "Naming a tab".
- `skills/session-browser/SKILL.md` — the agent-facing routing workflow.
- the token forensics kept with the downstream site — the measurement.
