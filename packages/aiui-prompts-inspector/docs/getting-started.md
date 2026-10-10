# Embed a saved prompt

Use this package in the UI that reads prompt records. Keep authoring and compilation in
`@habemus-papadum/aiui-prompts`, which runs in Node and browsers without UI dependencies.

```tsx
import { PromptPreview } from "@habemus-papadum/aiui-prompts-inspector";
import "@habemus-papadum/aiui-prompts-inspector/style.css";
import "katex/dist/katex.min.css";

<PromptPreview record={savedRecord} resolveAsset={asset => urls.get(asset.id)} />;
```

This is native Solid 2 JSX. `record` accepts semantic JSON loaded from storage. The condensed view
starts with Markdown/math/inline images and can toggle to raw text or open the full inspector.
Use `PromptInspector` for the full view directly. Use `mountPreview` or `mountInspector` in a plain
DOM host, and call the returned `dispose()` when removing it.

No stylesheet is mandatory. Host tokens and classes can customize each instance; the optional
`themes/aiui.css` bridge consumes the host's existing aiui design tokens. Source navigation, copying,
and archived asset resolution are callbacks. Nothing is sent to a model.

See [viewer API and behavior](../README.md), [theming](../../aiui-prompts/docs/theming.md), and the
[package migration guide](../../aiui-prompts/docs/adoption.md#package-split-and-native-solid-refactoring).
Operation and wire loading are documented there as well.
