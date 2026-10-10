# Explore the prompt authoring spike

This is a private, unpublished workspace experiment. Start with the [syntax bench](../README.md)
and [greeting example](../src/examples/01-greeting.prompt.tsx). No package installation from npm,
credentials, provider SDK or model request is involved.

From the repository root:

```sh
pnpm --filter @habemus-papadum/aiui-prompts-authoring-spike dev
pnpm --filter @habemus-papadum/aiui-prompts-authoring-spike examples
pnpm --filter @habemus-papadum/aiui-prompts-authoring-spike examples:check
```

Open <http://127.0.0.1:5218> for the browser playground. Pick an example, change its inputs,
and inspect composition, compiled content, current messages, and the request with history beside
the actual TSX source. Source editing happens in the example files; the browser shows them read-only.

The examples execute the stub runtime and compare their actual results with the checked-in
[expected artifacts](../expected/). Use them to review syntax, stage boundaries, source ownership
and prompt/turn/history semantics before committing to production contracts.
