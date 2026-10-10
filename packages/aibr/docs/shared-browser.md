# Sharing an aibr browser

The human and other agents may be using this browser at the same time. A profile shares cookies,
tabs, downloads, permissions, and browser-wide settings. Separate profiles provide isolation.

- Identify the requested tab before interacting. Create a new tab for independent work.
- Announce visible navigation or changes that may interrupt the human.
- Keep unrelated tabs open and preserve the window's size.
- Do not close or restart the browser as session cleanup.
- Coordinate before navigating a tab another participant is using, logging out, changing
  browser-wide settings, or clearing cookies.

aibr does not arbitrate tab ownership or serialize actions across agents. Use another profile
when concurrent work requires isolation. Stopping an MCP server disconnects that agent;
`aibr browser stop` closes the browser for everyone.
