/**
 * panes.tsx — the collapsible-pane styles the layout's debugging pane uses.
 *
 * The raw engine-event TracePane that lived here is DELETED (owner,
 * 2026-07-19): it was the rich trace viewer's poor cousin — a text list of
 * what ui/trace-pane.tsx shows with stages and images — and the layout comment
 * always said the debugging surfaces would go. (Git history has it.)
 */

export const PANES_STYLES = `
  .aiui-pane { margin: 8px 12px; font: 12px system-ui; max-width: 460px; }
  .aiui-pane summary { cursor: pointer; opacity: 0.75; }
`;
