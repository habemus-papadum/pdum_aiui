# Screen capture

See the [package guide](../README.md) for the controller, Solid components, crop modes, ownership,
Electron integration boundary, and browser tests. The working reference is
[`demos/screen-capture`](../../../demos/screen-capture).

Capture must start from a user gesture on HTTPS or localhost. For element cropping, select this
page's own browser tab. `capture.stream()` exposes the resulting standard `MediaStream` after the
initial crop succeeds; downstream consumers borrow that stream. Keep capture ownership at the
application level and call `stop()` when leaving the page, `dispose()` on final teardown.
