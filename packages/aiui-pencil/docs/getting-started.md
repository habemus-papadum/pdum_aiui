# Getting started

Start with the [package README](../README.md) for the public API and
[architecture](./architecture.md) for ownership and editing semantics.

Run `pnpm -C packages/aiui-pencil lab`. Choose the interface on your iPad's
network, copy the printed URL, and paste it into Safari using Universal Clipboard.
`LAB_INTERFACE=en0` skips the picker. The URL uses the actual Vite port.

The drawing pane stays fixed while the controls scroll independently. Pencil mode
starts enabled: use a pen or mouse to draw, then lift the pen and use two fresh
finger contacts to pan, pinch zoom, or twist. **Scene navigation** can disable
navigation, zoom, or rotation separately.
The touch readout beside these switches retains the last contact size and
decision after you lift your fingers. `navigation` means the gesture is being
applied; `held-during-pen` means those fingers need to lift and start again;
`navigation-disabled` means the navigation or Pencil-mode switch is off.
If the readout stays at "waiting for fingers", no touch input reached the canvas.

Draw around a symbol on the patterned reference page. Use **Scroll down/up** to
move it out of view and back, or **Zoom in/out** and **Rotate left/right** to inspect
the coordinate mapping. **Link ink and content** keeps the ink and page aligned;
switch it off to move the ink independently while scrolling only the page.
When unlinked, **Button target** chooses whether the pan/zoom/rotate buttons
move **Ink** or the **Reference page**; two-finger gestures continue to move ink.
**Reset view** returns to the origin without modifying ink. **Reflow content**
changes the actual DOM width, wrapping text and rearranging cards. Existing ink
is retained but hidden until **Resume at current coordinates**; that explicit
choice keeps its old coordinates, which may no longer line up with the content.

Draw once, change the numerical controls, and inspect raw points, smoothed paths,
corners, and dabs. Existing stroke IDs and raw samples remain stable while the
profile changes. Try both partial erasure and whole-stroke removal, undo/redo,
and cache eviction. Capture ink, draw more, then apply the fixture's sample
result: only unchanged captured ink is retired. The original image stays
available beside the sample result. This fixture exercises data handoff without
making an AI request.

Run `pnpm -C demos/circle dev` for live circle fitting. Completed ink fades while
the measured result remains; beginning another stroke starts the next turn.

For an application, begin with a positioned container and `PencilSurface`. Use its
`document` for data/editing and its `view` for display. Use `createInkSession`
when samples originate from recorded, generated, or externally supplied input.
Speech, prompt construction, symbolic documents, and interpretation belong to the
application. They can consume captures without declaring a selection or
annotation mode first.
