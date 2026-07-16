# @habemus-papadum/aiui-source-processor

The aiui source processor: the compile-time Babel pass that injects factory identity (name/loc/description for cell/control/action) and dev-only JSX source-location stamps, plus its Vite plugin. One transform, serve and build.

## Install

```sh
npm install @habemus-papadum/aiui-source-processor
```

## Usage

```ts
import { greet } from "@habemus-papadum/aiui-source-processor";

greet("world"); // "Hello, world!"
```
