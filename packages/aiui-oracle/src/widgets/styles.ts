/**
 * styles.ts — the widgets' own stylesheet, as a string a host concatenates
 * into its `<style>` (the house pattern: the intent panel's PANEL_STYLES is
 * BAR_STYLES + PILLS_STYLES + … in order).
 *
 * Deliberately THEME-NEUTRAL — system colors (`Canvas`/`CanvasText`) and
 * `color-mix(in srgb, currentColor …)`, never a hard-coded palette. A shipped
 * widget cannot assume a dark host: the oracle lab is dark by choice and keeps
 * its own richer rules (lab/src/styles.css, loaded after these and therefore
 * winning), while the intent panel follows the viewer's light/dark preference.
 * That is why this is not the lab's CSS extracted — it is the same structure
 * re-expressed in the one idiom that works everywhere.
 */

export const ORACLE_WIDGET_STYLES = `
  .aiui-oracle-control { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .aiui-oracle-control button { font: inherit; padding: 3px 8px; border-radius: 6px;
    cursor: pointer; color: inherit; background: transparent;
    border: 1px solid color-mix(in srgb, currentColor 25%, transparent); }
  .aiui-oracle-control button:disabled { opacity: 0.35; cursor: default; }
  .aiui-oracle-key { font: inherit; min-width: 16rem; padding: 3px 6px; border-radius: 6px;
    color: inherit; background: transparent;
    border: 1px solid color-mix(in srgb, currentColor 25%, transparent); }
  .aiui-oracle-reply { flex-basis: 100%; min-height: 1.2em; font-style: italic; opacity: 0.8; }
  .aiui-oracle-usage { font-size: 11px; opacity: 0.6; font-variant-numeric: tabular-nums; }
  .aiui-oracle-blocked { font-size: 12px; color: #d97706; }

  /* the mind strip — the ambient "what is it doing right now" line */
  .aiui-oracle-mind { display: flex; gap: 8px; align-items: baseline; padding: 4px 2px; }
  .aiui-oracle-mind-text { opacity: 0.7; font-style: italic; }
  .aiui-oracle-mind[data-status="live"] .aiui-oracle-mind-text { opacity: 1; font-style: normal; }

  /* the session viewer */
  .aiui-oracle-chips { display: flex; gap: 4px; margin: 4px 0 6px; flex-wrap: wrap; }
  .aiui-oracle-chip { font: inherit; font-size: 11px; padding: 1px 8px; border-radius: 999px;
    cursor: pointer; opacity: 0.55; color: inherit; background: transparent;
    border: 1px solid color-mix(in srgb, currentColor 20%, transparent); }
  .aiui-oracle-chip[data-on="true"] { opacity: 1;
    border-color: color-mix(in srgb, currentColor 45%, transparent);
    background: color-mix(in srgb, currentColor 8%, transparent); }
  .aiui-oracle-turns { display: flex; flex-direction: column; gap: 4px;
    max-height: 420px; overflow-y: auto; }
  .aiui-oracle-turn { border-radius: 8px;
    border: 1px solid color-mix(in srgb, currentColor 18%, transparent);
    background: color-mix(in srgb, currentColor 4%, transparent); }
  .aiui-oracle-turn-summary { display: block; width: 100%; text-align: left; font: inherit;
    font-size: 12px; padding: 5px 7px; cursor: pointer; color: inherit;
    background: none; border: none; }
  .aiui-oracle-turn[data-open="true"] .aiui-oracle-turn-summary {
    border-bottom: 1px solid color-mix(in srgb, currentColor 18%, transparent); }
  .aiui-oracle-turn-entries { padding: 4px 7px 6px; display: flex; flex-direction: column; gap: 2px; }
  .aiui-oracle-entry-line { display: flex; gap: 8px; align-items: baseline; width: 100%;
    text-align: left; background: none; border: none; color: inherit; padding: 1px 0;
    font: 11px ui-monospace, monospace; cursor: pointer; }
  .aiui-oracle-entry-line:disabled { cursor: default; }
  .aiui-oracle-entry-kind { opacity: 0.55; min-width: 6.5rem; text-align: right; flex-shrink: 0; }
  .aiui-oracle-entry[data-kind="error"] .aiui-oracle-entry-kind { color: #dc2626; opacity: 1; }
  .aiui-oracle-entry[data-kind="tool-call"] .aiui-oracle-entry-kind,
  .aiui-oracle-entry[data-kind="tool-result"] .aiui-oracle-entry-kind { color: #2563eb; opacity: 1; }
  .aiui-oracle-entry[data-kind="heard"] .aiui-oracle-entry-kind,
  .aiui-oracle-entry[data-kind="said"] .aiui-oracle-entry-kind { color: #16a34a; opacity: 1; }
  .aiui-oracle-entry-body { white-space: pre-wrap; word-break: break-word; }
  .aiui-oracle-entry-json { margin: 2px 0 4px 7.1rem; padding: 5px; border-radius: 6px;
    background: color-mix(in srgb, currentColor 8%, transparent); font-size: 11px;
    overflow-x: auto; }
`;
