/**
 * typing-target.ts — the ONE "does this key belong to a text field?" predicate.
 *
 * Three surfaces consume it, and drift between them was the hazard: the panel
 * document's key listener (ui/shell.tsx), the MV3 content script's in-turn
 * wholesale claim (ext/content.ts), and the CDP bootstrap's twin — which
 * STRINGIFIES this function in (cdp/page-script.ts `buildPageScript`), so it
 * must stay entirely self-contained: no imports, no captured values.
 *
 * The page-side rule it enables is a C0 contract change (BEHAVIOR.md "Sources
 * alongside turns"): in a turn, a key born inside a page's own input belongs
 * to the field, never to the grammar — the wholesale claim yields. The panel
 * learned this rule live (the segment editor's every keystroke was eaten);
 * the page tiers never had it at all.
 *
 * A superset of the modal kit's `isTypingTarget` (aiui-viz): adds SELECT
 * (arrow keys belong to a focused dropdown) and the closest() net for inputs
 * wrapped in labels. composedPath-aware, so shadow-DOM inputs count.
 */
export function isPageTypingTarget(event: KeyboardEvent): boolean {
  const target = (event.composedPath?.()[0] ?? event.target) as HTMLElement | null;
  if (!target || typeof target.closest !== "function") {
    return false;
  }
  return (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT" ||
    target.isContentEditable ||
    target.closest(
      'input, textarea, select, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"], [role="textbox"]',
    ) !== null
  );
}
