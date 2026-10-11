# Screen capture demo

Run `pnpm -C demos/screen-capture dev`, or open `/screen-capture` in the gallery.

Choose **Wave chart** or **Field notes**, then **Share screen…** and select this tab. The stream
appears in the preview with dimensions and measured FPS. In **Element only**, **Pick an element…**
selects the enclosing declared boundary, even when clicking its text or SVG. **Region** allows
individual elements in the example area. Escape cancels; up/down move to parent/child (between
declared boundaries in Element only). **Full surface** restores the selected source without
reopening its picker; **Change source…** then opens the general tab/window/display chooser.

Wave chart uses `ScreenCaptureTarget`; Field notes uses `captureTargetProps` on an existing div.
Both declare capture boundaries and set their isolation styles when the UI is built. The picker
does not change the styles of other elements. Switching an individual Region selection to Element
only explains that a declared boundary is required and preserves the current capture.

Vary chart width, motion, visibility, and the overlapping annotation. **Region** includes the
annotation; **Element only** excludes it. The browser tracks layout changes. Cropping support is
feature-detected; unsupported modes are explained in the controls. Whole tabs, windows, and displays
remain available where screen capture is supported. Hidden or unavailable targets and missing
initial frames are explained in the preview. Nothing is transmitted or recorded.

The demo's application-owned controller survives graph HMR and stops when the gallery leaves this
page. A component edit that replaces a cropped DOM node requires selecting its replacement.
The landing card never opens capture. Capture needs no credentials.

The scoped agent tools expose current capture state, Stop, clear-crop, crop-chart, isolate-chart,
and the layout controls. Starting capture uses the page button because the browser requires a user
gesture. The reusable implementation and tests live in
[`aiui-screen-capture`](../../packages/aiui-screen-capture/README.md).
