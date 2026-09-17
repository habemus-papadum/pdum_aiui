/**
 * styles.ts — the widgets' stylesheet as a string a host concatenates into
 * its `<style>`. NOTE: every `[data-x="true"]` selector here needs the attribute bound
 * as a STRING (`data-x={String(flag)}`): Solid 2 renders a boolean `true` as `data-x=""`,
 * which never matches. Theme-neutral: system colors and currentColor mixes, never
 * a palette — the demo's dark journal and a light panel both work.
 */

export const LIVE_WIDGET_STYLES = `
  .aiui-live-control { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .aiui-live-control button, .aiui-live-composer button, .aiui-live-keybox button {
    font: inherit; padding: 3px 8px; border-radius: 6px; cursor: pointer; color: inherit;
    background: transparent; border: 1px solid color-mix(in srgb, currentColor 25%, transparent); }
  .aiui-live-control button:disabled, .aiui-live-composer button:disabled { opacity: 0.35; cursor: default; }
  .aiui-live-meter { display: inline-flex; gap: 8px; font-size: 12px; font-variant-numeric: tabular-nums; opacity: 0.8; }
  .aiui-live-meter-cost { font-weight: 600; }
  .aiui-live-session-id { font: 11px ui-monospace, monospace; opacity: 0.55; }
  .aiui-live-error { color: #dc2626; font-size: 12px; }
  .aiui-live-blocked, .aiui-live-closed { font-size: 12px; color: #d97706; }

  .aiui-live-captions { display: grid; gap: 4px; }
  .aiui-live-caption { display: grid; grid-template-columns: 4.5rem 1fr; gap: 8px; align-items: baseline;
    padding: 4px 8px; border-radius: 8px; min-height: 1.6em;
    border: 1px solid color-mix(in srgb, currentColor 14%, transparent); transition: border-color 120ms; }
  .aiui-live-caption[data-speaking="true"] { border-color: color-mix(in srgb, currentColor 55%, transparent); }
  .aiui-live-caption-role { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; opacity: 0.55; }
  .aiui-live-caption[data-role="assistant"][data-speaking="true"] .aiui-live-caption-role { color: #a78bfa; opacity: 1; }
  .aiui-live-caption[data-role="user"][data-speaking="true"] .aiui-live-caption-role { color: #f87171; opacity: 1; }

  .aiui-live-tasks { display: flex; flex-direction: column; gap: 4px; }
  .aiui-live-empty { font-size: 12px; opacity: 0.6; padding: 6px; }
  .aiui-live-task { border-radius: 8px; border: 1px solid color-mix(in srgb, currentColor 18%, transparent);
    background: color-mix(in srgb, currentColor 4%, transparent); }
  .aiui-live-task[data-status="open"] { border-color: #d97706; }
  .aiui-live-task[data-status="failed"], .aiui-live-task[data-status="cancelled"] { opacity: 0.7; }
  .aiui-live-task-summary { display: flex; gap: 10px; align-items: baseline; width: 100%; text-align: left;
    font: inherit; font-size: 12px; padding: 5px 8px; cursor: pointer; color: inherit; background: none; border: none; }
  .aiui-live-task-id { font: 11px ui-monospace, monospace; opacity: 0.7; white-space: nowrap; }
  .aiui-live-task-status { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; opacity: 0.7; }
  .aiui-live-task[data-status="open"] .aiui-live-task-status { color: #d97706; opacity: 1; }
  .aiui-live-task[data-status="done"] .aiui-live-task-status { color: #16a34a; opacity: 1; }
  .aiui-live-task-request { flex: 1; min-width: 8rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .aiui-live-task-timing { font-variant-numeric: tabular-nums; white-space: nowrap; opacity: 0.8; }
  .aiui-live-task-head { display: flex; align-items: center; }
  .aiui-live-task-head .aiui-live-task-summary { flex: 1; }
  .aiui-live-task-cancel { font: inherit; font-size: 11px; color: #dc2626; cursor: pointer; background: none;
    border: none; padding: 4px 8px; }
  .aiui-live-task-detail { padding: 4px 8px 8px; display: flex; flex-direction: column; gap: 2px;
    border-top: 1px solid color-mix(in srgb, currentColor 14%, transparent); font-size: 12px; }
  .aiui-live-task-meta { opacity: 0.6; font-size: 11px; margin-bottom: 4px; }
  .aiui-live-task-append, .aiui-live-task-log { display: flex; gap: 8px; align-items: baseline; font: 11px ui-monospace, monospace; }
  .aiui-live-task-t { opacity: 0.5; min-width: 4.5rem; text-align: right; }
  .aiui-live-task-kind { min-width: 6rem; opacity: 0.8; }
  .aiui-live-task-append[data-kind="commentary"] .aiui-live-task-kind { color: #a78bfa; }
  .aiui-live-task-append[data-kind="thinking"] .aiui-live-task-kind { color: #60a5fa; }
  .aiui-live-task-append[data-kind="instructions"] .aiui-live-task-kind { color: #f59e0b; }
  .aiui-live-task-append[data-error="true"] .aiui-live-task-ack { color: #dc2626; }
  .aiui-live-task-text { flex: 1; white-space: pre-wrap; }
  .aiui-live-task-ack { opacity: 0.6; white-space: nowrap; }
  .aiui-live-task-log .aiui-live-task-text { opacity: 0.7; }
  .aiui-live-task-result { margin-top: 4px; font-style: italic; opacity: 0.8; }

  .aiui-live-chips { display: flex; gap: 4px; margin: 4px 0 6px; flex-wrap: wrap; align-items: center; }
  .aiui-live-chip { font: inherit; font-size: 11px; padding: 1px 8px; border-radius: 999px; cursor: pointer;
    opacity: 0.5; color: inherit; background: transparent;
    border: 1px solid color-mix(in srgb, currentColor 22%, transparent); }
  .aiui-live-chip[data-on="true"] { opacity: 1; font-weight: 600; color: Canvas; background: CanvasText; }
  .aiui-live-ledger-count { font-size: 11px; opacity: 0.55; margin-left: auto; }
  .aiui-live-rows { display: flex; flex-direction: column; gap: 1px; max-height: 480px; overflow-y: auto; }
  .aiui-live-row-line { display: flex; gap: 8px; align-items: baseline; width: 100%; text-align: left;
    background: none; border: none; color: inherit; padding: 1px 0; font: 11px ui-monospace, monospace; cursor: pointer; }
  .aiui-live-row-line:disabled { cursor: default; }
  .aiui-live-row-t { opacity: 0.5; min-width: 4.5rem; text-align: right; flex-shrink: 0; }
  .aiui-live-row-dir { opacity: 0.5; width: 1em; }
  .aiui-live-row-kind { opacity: 0.6; min-width: 5.5rem; flex-shrink: 0; }
  .aiui-live-row[data-kind="error"] .aiui-live-row-kind { color: #dc2626; opacity: 1; }
  .aiui-live-row[data-kind="delegation"] .aiui-live-row-kind { color: #d97706; opacity: 1; }
  .aiui-live-row[data-kind="append"] .aiui-live-row-kind { color: #a78bfa; opacity: 1; }
  .aiui-live-row[data-kind="ack"] .aiui-live-row-kind { color: #16a34a; opacity: 0.9; }
  .aiui-live-row[data-kind="backend"] .aiui-live-row-kind { color: #60a5fa; opacity: 1; }
  .aiui-live-row-summary { white-space: pre-wrap; word-break: break-word; }
  .aiui-live-row-json { margin: 2px 0 6px 5.5rem; font-size: 10px; white-space: pre-wrap; opacity: 0.85;
    max-height: 240px; overflow: auto; }

  .aiui-live-composer { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  .aiui-live-composer select, .aiui-live-composer input { font: inherit; font-size: 12px; padding: 3px 6px;
    border-radius: 6px; color: inherit; background: transparent;
    border: 1px solid color-mix(in srgb, currentColor 25%, transparent); }
  .aiui-live-composer input { flex: 1; min-width: 14rem; }
  .aiui-live-keybox { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
  .aiui-live-key { font: inherit; min-width: 18rem; padding: 3px 6px; border-radius: 6px; color: inherit;
    background: transparent; border: 1px solid color-mix(in srgb, currentColor 25%, transparent); }
  .aiui-live-key-hint { font-size: 11px; opacity: 0.6; }
`;
