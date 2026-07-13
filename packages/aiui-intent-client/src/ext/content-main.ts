/**
 * content-main.ts — five lines in the page's OWN world, because that is the
 * only place `window.__AIUI__` exists.
 *
 * A content script runs in an isolated world: it shares the DOM but not the
 * JavaScript realm, so the page's globals are invisible to it. The
 * aiui-instrumented-page fact (which unlocks `locate`, and one day the
 * jump-to-editor mode) is exactly such a global — hence this second, MAIN-world
 * script, whose whole job is to look and shout. `content.ts` listens.
 *
 * It touches nothing else. Code in the page's realm can be seen — and broken —
 * by the page, so it stays as small as the fact it carries.
 */

if ((window as unknown as { __AIUI__?: unknown }).__AIUI__ !== undefined) {
  window.postMessage({ aiuiInstrumented: true }, "*");
}
