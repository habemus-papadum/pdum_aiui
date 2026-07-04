# @habemus-papadum/aiui-util

Shared utilities for aiui packages (cache dirs, etc.).

## Install

```sh
npm install @habemus-papadum/aiui-util
```

## Usage

### `cacheDir(namespace?, options?)`

Resolve (and by default create) the aiui cache directory. Different packages cache
different kinds of data, so each passes its own `namespace`:

```ts
import { cacheDir } from "@habemus-papadum/aiui-util";

cacheDir();                          // ~/.cache/aiui  (created)
cacheDir("claude");                  // ~/.cache/aiui/claude  (created)
cacheDir("claude", { create: false }); // resolve the path without touching disk
```

Resolution order:

1. `$AIUI_CACHE` — explicit override, used verbatim as the cache root.
2. `$XDG_CACHE_HOME/aiui` — per the XDG Base Directory spec (absolute paths only).
3. `~/.cache/aiui` — the default.
