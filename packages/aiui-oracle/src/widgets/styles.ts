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
  /* the usage strip — read peripherally, so glyph pairs and abbreviated counts */
  .aiui-oracle-usage { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px;
    font-size: 11px; font-variant-numeric: tabular-nums; padding: 2px; }
  .aiui-oracle-usage-chip { display: inline-flex; align-items: baseline; gap: 3px; opacity: 0.7;
    white-space: nowrap; cursor: help; }
  .aiui-oracle-usage-icon { font-size: 10px; letter-spacing: -1px; }
  /* Audio dominates the bill, so it is the pair that stays legible; cached is
     the one you WANT going up, so it reads as good news rather than spend. */
  .aiui-oracle-usage-chip[data-kind="out-audio"],
  .aiui-oracle-usage-chip[data-kind="in-audio"] { opacity: 1; }
  .aiui-oracle-usage-chip[data-kind="cached"] { color: #16a34a; opacity: 1; }
  .aiui-oracle-usage-cost { font-weight: 600; cursor: help;
    font-variant-numeric: tabular-nums; }
  .aiui-oracle-usage-unpriced { color: #d97706; cursor: help; }
  .aiui-oracle-blocked { font-size: 12px; color: #d97706; }

  /* the mind strip — the ambient "what is it doing right now" line */
  .aiui-oracle-mind { display: flex; gap: 8px; align-items: baseline; padding: 4px 2px; }
  .aiui-oracle-mind-text { opacity: 0.7; font-style: italic; }
  .aiui-oracle-mind[data-status="live"] .aiui-oracle-mind-text { opacity: 1; font-style: normal; }

  /* the session viewer */
  .aiui-oracle-chips { display: flex; gap: 4px; margin: 4px 0 6px; flex-wrap: wrap; }
  /* An OFF chip is outlined and faded; an ON chip is filled and inverted. The
     two used to differ only by opacity and an 8% wash, which read as no
     response to a click at all — a toggle has to look toggled. */
  .aiui-oracle-chip { font: inherit; font-size: 11px; padding: 1px 8px; border-radius: 999px;
    cursor: pointer; opacity: 0.5; color: inherit; background: transparent;
    transition: background-color 90ms, color 90ms, opacity 90ms;
    border: 1px solid color-mix(in srgb, currentColor 22%, transparent); }
  .aiui-oracle-chip:hover { opacity: 0.8;
    border-color: color-mix(in srgb, currentColor 40%, transparent); }
  .aiui-oracle-chip:active { transform: translateY(1px); }
  .aiui-oracle-chip[data-on="true"] { opacity: 1; font-weight: 600;
    color: Canvas; background: CanvasText;
    border-color: color-mix(in srgb, currentColor 60%, transparent); }
  .aiui-oracle-chip[data-on="true"]:hover { opacity: 0.85; }
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

  /* the park banner — for someone who walked away, not someone watching */
  .aiui-oracle-park { display: flex; align-items: center; gap: 8px; padding: 6px 10px;
    border-radius: 8px; font-size: 12px;
    border: 1px solid color-mix(in srgb, #d97706 55%, transparent);
    background: color-mix(in srgb, #d97706 12%, transparent); }
  .aiui-oracle-park-icon { font-size: 14px; }
  .aiui-oracle-park-text { flex: 1; min-width: 0; }
  .aiui-oracle-park-note { opacity: 0.65; }
  .aiui-oracle-park button { font: inherit; font-size: 11px; padding: 2px 10px;
    border-radius: 6px; cursor: pointer; color: inherit; background: transparent;
    border: 1px solid color-mix(in srgb, currentColor 40%, transparent); }
  .aiui-oracle-park button:hover { background: color-mix(in srgb, currentColor 10%, transparent); }

  /* the params widgets. A row is a BLOCK (name + control, then a status line),
     never a cell in a shared grid: rows carry a variable number of trailing
     annotations, which sheared a grid's columns apart, and a fixed multi-column
     layout could not survive the side panel's width either. */
  .aiui-oracle-params { display: flex; flex-direction: column; gap: 10px; font-size: 11px; }
  .aiui-oracle-param-group { display: flex; flex-direction: column; gap: 5px; }
  .aiui-oracle-param-group-name { font: 10px ui-monospace, monospace; letter-spacing: 0.06em;
    text-transform: uppercase; opacity: 0.45; padding-bottom: 2px;
    border-bottom: 1px solid color-mix(in srgb, currentColor 15%, transparent); }
  .aiui-oracle-param-head input[type="range"] { padding: 0; accent-color: currentColor; }
  .aiui-oracle-param-head { display: flex; align-items: center; gap: 8px; }
  .aiui-oracle-param-name { flex: 1 1 auto; min-width: 0; cursor: help;
    font-family: ui-monospace, monospace;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .aiui-oracle-param-head input, .aiui-oracle-param-head select { font: inherit;
    flex: 0 0 10rem; max-width: 55%; padding: 2px 4px; border-radius: 4px; color: inherit;
    background: transparent;
    border: 1px solid color-mix(in srgb, currentColor 25%, transparent); }
  .aiui-oracle-param-head input:disabled, .aiui-oracle-param-head select:disabled {
    opacity: 0.4; }
  .aiui-oracle-param-foot { display: flex; flex-wrap: wrap; gap: 4px 10px; padding-left: 2px;
    font-size: 10px; opacity: 0.6; }
  .aiui-oracle-param-effective { font-family: ui-monospace, monospace; }
  .aiui-oracle-param-effective strong { font-weight: 600; opacity: 1; }
  .aiui-oracle-param-default { font-family: ui-monospace, monospace; opacity: 0.75; }
  .aiui-oracle-param-why { font-style: italic; }
  .aiui-oracle-param[data-drift="true"] .aiui-oracle-param-foot { opacity: 1; }
  .aiui-oracle-param[data-drift="true"] .aiui-oracle-param-effective { color: #d97706; }
  .aiui-oracle-param-drift { color: #d97706; font-weight: 700; letter-spacing: 0.04em; }
  .aiui-oracle-params-note, .aiui-oracle-params-error { margin: 2px 0 0; opacity: 0.6; }
  .aiui-oracle-params-error { color: #dc2626; opacity: 1; font-family: ui-monospace, monospace; }
`;
