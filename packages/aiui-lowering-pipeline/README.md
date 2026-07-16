# @habemus-papadum/aiui-lowering-pipeline

The intent lowering pipeline: the framework-free core that folds a multimodal intent event stream into the lowered agent prompt (composeIntent), shared by the channel and the intent tools.

## Install

```sh
npm install @habemus-papadum/aiui-lowering-pipeline
```

## Usage

```ts
import { greet } from "@habemus-papadum/aiui-lowering-pipeline";

greet("world"); // "Hello, world!"
```
