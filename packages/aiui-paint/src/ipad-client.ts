/**
 * The self-contained iPad client page, served by the relay at `GET /`.
 *
 * The page itself lives in `assets/ipad-client.html` — a REAL html file, so
 * the inline JS gets syntax highlighting, honest escaping, and greppability.
 * It used to live here as one giant TS template literal, and paid the classic
 * embedded-language tax: escape sequences were processed by *TypeScript*
 * before the page was served, so a `"\n"` typed into the inline JS shipped a
 * raw newline inside a string literal and killed the whole client with a
 * SyntaxError (docs/guide/development.md, "Every string boundary is a
 * compiler you can't see"). Now the file ships verbatim.
 *
 * The read is module-level and path-computed (not a `new URL(...)` literal,
 * which Vite's lib build would try to rewrite as an asset reference): from
 * `src/` in the source-first runtimes (tsx, Vitest) and from `dist/` in an
 * installed package, `../assets/ipad-client.html` resolves the same, and the
 * `assets/` dir ships via the package's `files`. An eager read means a
 * missing asset fails at import — which `pnpm test:packaging`'s sidecar
 * smoke turns into a caught packaging error, not a runtime 500.
 *
 * The page implements the same small JSON control protocol as `protocol.ts`
 * (kept in sync by hand; the TS module is the contract, the page is one
 * hand-written consumer). Video frames arrive as binary Blobs and drive an
 * `<img>`; pen strokes and finger gestures become normalized intents.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const IPAD_CLIENT_HTML = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "ipad-client.html"),
  "utf8",
);
