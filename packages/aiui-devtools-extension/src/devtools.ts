/**
 * The (invisible) devtools page: its only job is to register the "aiui" panel.
 * Runs once per DevTools window; the panel itself is panel.html + panel.ts.
 */
chrome.devtools.panels.create("aiui", "", "panel.html");
