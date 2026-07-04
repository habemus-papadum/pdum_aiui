> **DRAFT — parked for review, loaded nowhere.** This is the proposed full content for the
> `session-browser` skill. Once approved, fold it back into
> `marketplace/plugins/session-browser/skills/session-browser/SKILL.md` (currently an inert stub).

---
name: session-browser
description: Use whenever interacting with the browser through the chrome-devtools MCP tools in an aiui session. The browser is SHARED with the user — announce actions before taking them, and preserve the user's tabs and context.
---

# Driving the shared session browser

The chrome-devtools MCP in this session is attached to a **session browser**: one visible Chrome
window that you and the user share. It is not a private automation browser. The user watches the
same tabs you drive, may be logged into services in this profile, and may be mid-thought on the
exact page you're about to touch. (This skill is only loaded when the session was launched with
that shared wiring; a private, MCP-launched browser has none of these constraints.)

## Announce before acting

Immediately before any *visible* browser action, say what you're about to do and where, in one
short line of the transcript:

> Clicking **Submit order** on the checkout tab.
> Opening the staging dashboard in a new tab.
> Typing the test address into the shipping form.

Then act. The user sees the browser move either way — an unannounced click or navigation reads as
a glitch. This applies to clicks, typing and form fills, navigation, opening/closing tabs, and
scrolling that loses the user's place. It does not apply to pure reads (screenshots, console
reads, evaluating expressions that don't mutate the page).

Dedicated tools for **in-page visual indication** — briefly highlighting the element you're about
to interact with, in the page itself — will ship in this plugin later. When they appear in your
toolset, use them before each interaction *in addition to* the transcript line; they make the
announcement legible in the window itself.

## Preserve the user's context

- Prefer **opening a new tab** over navigating away from whatever the user has open, unless they
  asked you to navigate.
- **Never close a tab you didn't open.**
- If you must act in the user's current tab, say so first, and restore it (navigate back) when
  you're done unless the change was the point.
- When the user refers to something deictically — "this chart", "that button" — it's almost
  certainly on the tab they're currently viewing. **Screenshot first**, act second.
- Anything you log into stays in the shared profile across sessions. Say so when you do it.

## When browser tools misbehave

The session's browser wiring is inspectable rather than guessable:

- `aiui chrome status` (run in the project directory) reports how a launch from here would
  connect — attach vs launch, the endpoint, the profile.
- The channel server's `GET /debug/api/info` includes `launch.chromeDevtools`: exactly how *this*
  session's MCP was wired at launch (connection mode, browser URL, user data dir, extension).
  The aiui DevTools panel's Server tab renders the same data.

If the MCP reports no browser or connection errors, relay what the wiring says instead of
retrying blindly — e.g. "the session was launched attached to http://127.0.0.1:9222, which is no
longer responding; restarting `aiui browser` (or the tunnel, for remote sessions) should restore
it."
