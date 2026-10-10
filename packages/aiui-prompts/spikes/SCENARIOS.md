# Shared scenario ledger

The spikes explore the same questions with independent implementations. Authoring outputs are
computed by the stub library; inspector outputs and provenance are fixture data. This ledger is
the shared contract, not a shared runtime or a claim that the UI validates the compiler.

| Scenario | Authoring question | Inspection question | Python reference |
| --- | --- | --- | --- |
| Greeting and interpolation | How do ordinary values become typed prompt content? | Can a dynamic value be traced from preview through raw text to fixture source? | `tests/test_core.py`, `widgets/demos/demo_00.py` |
| Reused evidence | Can one fragment resolve to different heading depths without mutation? | Can repeated occurrences be selected and folded independently? | `tests/test_render_hints.py`; the new spike deliberately removes clone-on-reuse |
| Scientific evidence | Do raw TeX, numeric precision, and text–image–text survive? | Can an equation reveal every contributor and an image open a stable preview? | `widgets/demos/demo_01.py`, `demo_03.py`, `tests/test_image_interpolation.py` |
| Dynamic table | How do interpolated cells and rows fit normal TypeScript? | Does a table cell navigate back to the right raw/source region? | `widgets/demos/demo_04.py` |
| Revised prompt | What changes in structure, text and image identity? | Can both valid previews be compared without parsing diff markup as math? | `widgets/demos/demo_structured_diff.py`, `demo_rendered_diff.py` |
| One turn and separate history | Can several current messages coexist with fixed replay items or a remote continuation? | Is new input distinguished from history instead of flattened into one giant prompt? | New behavior; no equivalent full history abstraction in the Python library |

The reference paths above are relative to the Python package's `src/t_prompts/` for `widgets/demos`
and to its repository root for `tests`. The original checkout is a research reference only; these
spikes do not import its code or require Python.

Important experiments include partial folding of an equation with multiple owners, keyed state
across a fixture revision, and copying original raw content while it is visually folded. A mock
can expose those interactions without pretending to implement general Markdown/TeX source maps.
