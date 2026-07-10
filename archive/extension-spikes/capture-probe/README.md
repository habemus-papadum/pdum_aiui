# capture-probe — M1 / M2 / M4 / M6

Plain-JS MV3 scratch extension. No build step. Load unpacked:
`chrome://extensions` → Developer mode → **Load unpacked** → this folder. Existing tabs need a
reload before the content script is present in them.

Everything logs into the extension's **side panel** (click the toolbar action to open it —
that click is also the "invocation" several probes depend on). Snapshots render inline in the
panel so you can *see* what each capture surface returned; that's the ground truth for M2.

## Run-book

### M4 — tabCapture invocation semantics (do these in order, they're order-sensitive)

1. Fresh browser start (or reload the extension). **Without clicking the action on it**, select a
   tab in the panel's tab list (open the panel from another tab's action click) and hit
   **capture selected tab → offscreen**.
   - Succeeds → `<all_urls>` host permission relaxes invocation (M4a = yes).
   - Fails (expected per docs) → note the error; then click the action on that tab and retry.
2. Invoke a tab, switch away to another tab, then capture the first (now background) tab via the
   dropdown (M4b: previously-invoked background tab).
3. With one capture running, switch tabs a few times, then **snapshot all** — do frames still
   flow from the captured tab (continuity)? Then start a second capture on another invoked tab
   and **getCapturedTabs()** (M4c: two concurrent video captures).
4. Watch the tab-strip capture indicator throughout; note when it appears/disappears.

### M1 — crop/restrict on tabCapture tracks

1. Capture a tab into the offscreen doc; the track report logs
   `hasCropTo`/`hasRestrictTo`/constructor (existence on a `getUserMedia`-derived tab track).
2. **offscreen: cropTo/restrictTo error shapes** — targets minted from the *offscreen* DOM
   against a tab track; records the exact rejection.
3. **capture selected tab IN-PAGE** — the decisive leg: the stream id is minted with
   `consumerTabId` = the captured tab, consumed by the content script *in that tab*, which mints
   `CropTarget`/`RestrictionTarget` from a locally injected element and applies both. Snapshots
   land before/after; if the "after restrictTo" snapshot shows only the probe box, the
   capture-plane design works picker-free in an extension.
4. **M1 transport** — sends a real `CropTarget` through `chrome.tabs.sendMessage`; the logged
   response shows what (if anything) survived the messaging codec.

### M2 — split view matrix (needs Chrome ≥ ~145 with split view)

Set up: right-click a tab → *Add tab to new split view* (or drag one tab onto another). Then:

1. **refresh tab list** — does `Tab.splitViewId` exist, and do the two tabs share a view id?
2. **captureVisibleTab (this window)** — snapshot shows one pane or both?
3. Capture each split tab via tabCapture — snapshot dimensions vs the pane's
   `window.innerWidth` (the SW logs `pageInfo` dims; compare).
4. **getDisplayMedia from panel**, pick the browser *window* — snapshot should show both panes +
   chrome. Note what the picker offered.
5. Note which pane is `active: true` in the tab list while focus moves between panes.

### M6 — panel lifetime

Leave the panel open (hidden behind other windows is fine) for hours; **lifetime report** shows
heartbeat gaps > ~35 s (throttling/discard evidence). The report survives panel reloads via
`chrome.storage.session` (cleared on browser exit).

## Recording results

Write findings into `../RESULTS.md` (spike id, Chrome version, date, personal-Chrome vs
session-browser, and the snapshot evidence where it matters).
