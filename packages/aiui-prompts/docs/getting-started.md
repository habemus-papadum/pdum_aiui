# Review the prompt spikes

Two experiments live under this package's `spikes/`, unpublished and separate from the installable library.
Start with its [README](../README.md), run the authoring examples, and open the independent inspector.

```sh
pnpm --filter @habemus-papadum/aiui-prompts-authoring-spike dev
pnpm --filter @habemus-papadum/aiui-prompts-authoring-spike examples
pnpm --filter @habemus-papadum/aiui-prompts-inspector-spike dev
```

The authoring playground runs at <http://127.0.0.1:5218>; the inspector runs at
<http://127.0.0.1:5217>. The authoring page executes the real examples and displays their source
alongside composition, compilation, current-turn, and request outputs.

The first experiment explores the API and stage outputs. The second explores user interactions
with fixed source and preview mappings. Implementation and mapping limitations are documented in
each spike's README. Production APIs will be chosen after reviewing both.
