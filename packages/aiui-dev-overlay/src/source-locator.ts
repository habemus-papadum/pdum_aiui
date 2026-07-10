/**
 * The aiui compiler — compile-time identity, description, and source-location
 * injection, absorbed into the dev overlay from the demo's
 * `babel-source-locator.mjs` and promoted from a one-off stamper to a
 * table-driven pass (docs/proposals/front_end_controls_guide_and_more.md §2a).
 * Node-side only (behind the `./vite` subpath): the browser bundle never
 * imports this.
 *
 * Two halves with DIFFERENT lifecycles:
 *
 *  1. **JSX stamping** (dev-only) — every *host* JSX element gets
 *     `data-source-loc="src/ui/Controls.tsx:42:7"` (path relative to the app
 *     root, 1-based line:column). Paired with the overlay's injected
 *     `window.__AIUI__.sourceRoot`, `sourceRoot + "/" + el.dataset.sourceLoc`
 *     is an absolute, clickable `file:line:col`. Only host elements (lowercase
 *     tags) are stamped — stamping a component would just pass a mystery prop.
 *
 *  2. **Factory call-site injection** (dev AND build — LOAD-BEARING) — a call
 *     to a factory in the {@link FactorySpec} table gets identity injected
 *     into its options object: `const catalog = cell(deps, compute)` becomes
 *     `cell(deps, compute, { name: "catalog", loc: "src/…:77", description })`,
 *     with the name inferred from where the value lands and the description
 *     lifted from the leading doc comment. For `control()`/`action()` the
 *     injected name is also the durable-persistence key and the agent-tool
 *     identity, which is why this half runs in production builds too and why
 *     the runtime fails loudly when it is missing.
 *
 * The principles this framework holds itself to (each one ratified, most paid
 * for — see the proposal §2a and docs/guide/frontend-hard-won.md):
 *
 *  - **Compile time injects identity and location only.** No behavior may
 *    depend on the transform beyond naming: with the plugin off, cells go
 *    anonymous (legal) and controls/actions throw loudly at runtime for a
 *    missing name (never silently anonymous — their names are keys).
 *  - **Injection is idempotent.** Keys already present in an options object
 *    are never clobbered; running the pass twice is a no-op.
 *  - **Naming is syntactic.** The callee must literally be a configured
 *    identifier — aliased or re-exported factories are invisible. A
 *    deliberate 90% heuristic, documented rather than "fixed".
 *  - **Explicit names must be compile-time string literals.** A dynamic name
 *    defeats the durable key, the tool identity, and the agent's ability to
 *    grep for it — rejected with a code-framed error, not a warning.
 *  - **All work happens in `Program.enter` with an explicit traverse** (a
 *    paid-for finding): this pass shares a babel run with babel-preset-solid,
 *    whose compiler visits each outermost `JSXElement`, compiles the whole
 *    subtree internally, and replaces it — a `JSXOpeningElement` visitor in
 *    another plugin never fires for the children. `Program.enter` runs before
 *    any replacement; an explicit `path.traverse` sees the intact tree.
 *
 * `@babel/core` is an OPTIONAL peer: it is `import type`-only here (erased at
 * build) and loaded lazily via dynamic import inside the Vite plugin, so it is
 * required only when a consumer opts into the locator.
 */
import type { types as BabelTypes, NodePath, PluginObj, PluginPass, Visitor } from "@babel/core";
import type { Plugin, Rollup } from "vite";

/** @internal — the `@babel/core` module shape, loaded lazily. */
type BabelModule = typeof import("@babel/core");

const ATTR = "data-source-loc";

/** The friendly error when the optional `@babel/core` peer is not installed. */
const LOAD_ERROR = "aiuiDevOverlay locator needs @babel/core — install it as a devDependency";

/** One factory the compiler injects identity into. */
export interface FactorySpec {
  /**
   * Callee identifier, matched syntactically — the call must literally read
   * `<callee>(…)`; aliases and re-exports are invisible (by design).
   */
  callee: string;
  /** Inclusive argument-count range for a call to qualify. */
  args: { min: number; max: number };
  /**
   * Index of the options object. When it can be ≥ the call's argument count
   * the argument is *appended* on demand (cell: index 2 of a 2-arg call);
   * when every qualifying call already has it (control/action: index 0) it is
   * only ever merged into. A present-but-non-object options argument (a
   * spread, a call) is left alone — the runtime's loud-failure guard is the
   * backstop for those.
   */
  optionsArg: number;
  /** Keys injected when absent. `name` behavior is governed by `namePolicy`. */
  inject: ReadonlyArray<"name" | "loc" | "description">;
  /**
   * What happens when a call has no explicit `name` and no inferrable
   * binding (not assigned to a `const`, an object property, or a plain
   * assignment):
   *  - `"optional"` — skip injection entirely (anonymous cells are legal and
   *    get no loc/description either, exactly the pre-table behavior);
   *  - `"required"` — compile error with a code frame (a control/action name
   *    is a durable key and a tool identity; the runtime would throw anyway,
   *    so fail earlier and better).
   */
  namePolicy: "optional" | "required";
}

/** The `cell(deps, compute, opts?)` shape for a given callee name. */
export function cellFactory(callee = "cell"): FactorySpec {
  return {
    callee,
    args: { min: 2, max: 3 },
    optionsArg: 2,
    inject: ["name", "loc", "description"],
    namePolicy: "optional",
  };
}

/** The single-options-object shape (`control({…})`, `action({…})`). */
export function optionsFactory(callee: string): FactorySpec {
  return {
    callee,
    args: { min: 1, max: 1 },
    optionsArg: 0,
    inject: ["name", "loc", "description"],
    namePolicy: "required",
  };
}

/** The default table: `cell`, plus the control-surface factories. */
export function defaultFactories(): FactorySpec[] {
  return [cellFactory(), optionsFactory("control"), optionsFactory("action")];
}

export interface SourceLocatorOptions {
  /**
   * App root for relativizing filenames; a stamped/injected path is
   * `file.slice(root.length)`. Defaults to `""` (absolute paths).
   */
  root?: string;
  /**
   * The factory table. Defaults to {@link defaultFactories}; pass `[]` to
   * disable call-site injection entirely (JSX stamping is independent).
   */
  factories?: FactorySpec[];
  /**
   * Back-compat sugar: names treated as cell-shaped factories. Ignored when
   * `factories` is given. `[]` disables call-site injection (the historical
   * "keep JSX stamping only" contract).
   */
  cellFactories?: string[];
  /**
   * Stamp `data-source-loc` on host JSX elements (default true). The Vite
   * plugin turns this off for production builds — instrumentation is dev-only;
   * identity injection is not.
   */
  stampJsx?: boolean;
}

/** Resolve the effective factory table from the options (back-compat aware). */
function resolveFactories(options: SourceLocatorOptions): FactorySpec[] {
  if (options.factories) return options.factories;
  if (options.cellFactories) return options.cellFactories.map((name) => cellFactory(name));
  return defaultFactories();
}

/**
 * Comments that are tooling directives or section banners, never descriptions.
 * Kept syntactic and conservative: when in doubt, a comment IS a candidate
 * description (an explicit `description` always wins anyway).
 */
const DIRECTIVE_COMMENT =
  /^\s*(?:biome-ignore|eslint|@ts-|prettier-|@vitest-environment|<\/?aiui-scenery|@__PURE__|#__PURE__|v8 ignore|-{2,})/;

/**
 * A human description from a node's leading comments: the LAST non-directive
 * comment (closest to the declaration; a section banner further up loses to
 * the docblock), with `//` runs merged when the lines are contiguous. JSDoc
 * margins are stripped, tag sections (`@param …`) dropped, whitespace
 * collapsed — the same characters that render as the editor tooltip become the
 * registry description (the ratified JSDoc convention; `//` accepted too).
 */
function descriptionFromComments(
  comments: ReadonlyArray<BabelTypes.Comment> | null | undefined,
): string | undefined {
  if (!comments || comments.length === 0) return undefined;
  const usable = comments.filter((c) => !DIRECTIVE_COMMENT.test(c.value));
  if (usable.length === 0) return undefined;

  const last = usable[usable.length - 1];
  let raw: string;
  if (last.type === "CommentBlock") {
    raw = last.value;
  } else {
    // Merge the maximal run of contiguous trailing line comments (`// a` over
    // `// b` is one two-line description, not two candidates).
    const run: string[] = [last.value];
    let line = last.loc?.start.line;
    for (let i = usable.length - 2; i >= 0; i--) {
      const c = usable[i];
      if (c.type !== "CommentLine" || line === undefined || c.loc?.end.line !== line - 1) break;
      run.unshift(c.value);
      line = c.loc?.start.line;
    }
    raw = run.join("\n");
  }

  // Strip JSDoc margins first (`\s` does not match the `*` gutter), then cut
  // at the first tag line — `@param`/`@remarks` sections are metadata, not
  // description.
  const lines = raw.split("\n").map((l) => l.replace(/^\s*\*+\s?/, "").trim());
  const tagAt = lines.findIndex((l) => l.startsWith("@"));
  const text = (tagAt === -1 ? lines : lines.slice(0, tagAt)).join(" ").replace(/\s+/g, " ").trim();
  return text.length > 0 ? text : undefined;
}

/**
 * The babel plugin (both halves). Kept a plain function so it can be dropped
 * into any `@babel/core` `plugins` array — the standalone {@link sourceLocatorVite}
 * pass, or a consumer's existing babel pass at real-app scale.
 */
export function sourceLocatorBabel(
  babel: { types: typeof BabelTypes },
  options: SourceLocatorOptions = {},
): PluginObj {
  const t = babel.types;
  const root = options.root ?? "";
  const stampJsx = options.stampJsx ?? true;
  const factories = new Map(resolveFactories(options).map((f) => [f.callee, f]));

  return {
    name: "aiui-source-locator",
    visitor: {
      Program(programPath: NodePath<BabelTypes.Program>, state: PluginPass) {
        const file = state.file.opts.filename ?? "";
        const rel =
          root && file.startsWith(root) ? file.slice(root.length).replace(/^\//, "") : file;
        const visitor: Visitor = {
          JSXOpeningElement(path) {
            if (!stampJsx) return;
            const name = path.node.name;
            if (name.type !== "JSXIdentifier" || !/^[a-z]/.test(name.name)) return;
            if (!path.node.loc) return;
            const exists = path.node.attributes.some(
              (a) =>
                a.type === "JSXAttribute" &&
                a.name.type === "JSXIdentifier" &&
                a.name.name === ATTR,
            );
            if (exists) return;
            const { line, column } = path.node.loc.start;
            path.node.attributes.push(
              t.jsxAttribute(
                t.jsxIdentifier(ATTR),
                t.stringLiteral(`${rel}:${line}:${column + 1}`),
              ),
            );
          },

          CallExpression(path) {
            const callee = path.node.callee;
            if (callee.type !== "Identifier") return;
            const spec = factories.get(callee.name);
            if (!spec) return;
            const args = path.node.arguments;
            if (args.length < spec.args.min || args.length > spec.args.max) return;
            if (!path.node.loc) return;
            injectIdentity(t, path, spec, rel);
          },
        };
        programPath.traverse(visitor);
      },
    },
  };
}

/** Object-literal keys present on an options object (Identifier or string). */
function presentKeys(opts: BabelTypes.ObjectExpression): Set<string> {
  const keys = new Set<string>();
  for (const p of opts.properties) {
    if (p.type !== "ObjectProperty") continue;
    if (p.key.type === "Identifier") keys.add(p.key.name);
    else if (p.key.type === "StringLiteral") keys.add(p.key.value);
  }
  return keys;
}

/** The explicit `name` property of an options object, if any. */
function nameProperty(opts: BabelTypes.ObjectExpression): BabelTypes.ObjectProperty | undefined {
  for (const p of opts.properties) {
    if (p.type !== "ObjectProperty") continue;
    const key =
      p.key.type === "Identifier" ? p.key.name : p.key.type === "StringLiteral" ? p.key.value : "";
    if (key === "name") return p;
  }
  return undefined;
}

/**
 * Infer a factory value's name from where it lands, plus the node its doc
 * comment attaches to: `const kappa = control(…)` (and the `export` wrapping
 * it), `rose: cell(…)` in an object literal, `x = cell(…)` — the same three
 * positions the cell injection has always recognized.
 */
function bindingOf(path: NodePath<BabelTypes.CallExpression>): {
  name?: string;
  commentNode?: BabelTypes.Node;
} {
  const parent = path.parent;
  if (parent.type === "VariableDeclarator" && parent.id.type === "Identifier") {
    // Comments attach to the declarator, its declaration, or the export
    // statement wrapping it — closest first.
    const declaration = path.parentPath?.parentPath;
    const exported =
      declaration?.parentPath?.node.type === "ExportNamedDeclaration"
        ? declaration.parentPath.node
        : undefined;
    const commentNode =
      (parent.leadingComments?.length ? parent : undefined) ??
      (declaration?.node.leadingComments?.length ? declaration.node : undefined) ??
      exported ??
      declaration?.node;
    return { name: parent.id.name, commentNode };
  }
  if (parent.type === "ObjectProperty" && parent.key.type === "Identifier") {
    return { name: parent.key.name, commentNode: parent };
  }
  if (parent.type === "AssignmentExpression" && parent.left.type === "Identifier") {
    const statement = path.parentPath?.node;
    return { name: parent.left.name, commentNode: statement ?? parent };
  }
  // A bare statement (`action({ … });`): no name, but its comment still counts.
  if (parent.type === "ExpressionStatement") {
    return { commentNode: parent };
  }
  return {};
}

/** The injection half: names, locs, descriptions — per the spec's table row. */
function injectIdentity(
  t: typeof BabelTypes,
  path: NodePath<BabelTypes.CallExpression>,
  spec: FactorySpec,
  rel: string,
): void {
  const args = path.node.arguments;
  const existing = args[spec.optionsArg];

  // A present-but-non-literal options expression is left alone: we cannot see
  // inside `control(makeOpts())`. The runtime's missing-name guard is the
  // backstop; erroring here would reject legitimate dynamic composition.
  if (existing && existing.type !== "ObjectExpression") return;
  const opts = existing as BabelTypes.ObjectExpression | undefined;
  const keys = opts ? presentKeys(opts) : new Set<string>();

  // ---- name: verify an explicit one, or infer one --------------------------
  const binding = bindingOf(path);
  let inferredName: string | undefined;
  if (spec.inject.includes("name")) {
    if (opts && keys.has("name")) {
      const prop = nameProperty(opts);
      if (prop && prop.value.type !== "StringLiteral") {
        throw path.buildCodeFrameError(
          `[aiui compiler] ${spec.callee}() name must be a compile-time string literal — ` +
            `it is a durable key, a tool identity, and a grep target. Use a plain "…" string.`,
        );
      }
    } else if (binding.name) {
      inferredName = binding.name;
    } else if (spec.namePolicy === "required") {
      throw path.buildCodeFrameError(
        `[aiui compiler] ${spec.callee}(…) needs a name: assign it to a named binding ` +
          `(const kappa = ${spec.callee}(…)) or pass { name: "…" }. The name is the durable ` +
          `key and the agent-tool identity, so it cannot be anonymous.`,
      );
    } else {
      return; // anonymous cells stay anonymous — no loc/description either
    }
  }

  // ---- assemble the injected properties -------------------------------------
  const inject: BabelTypes.ObjectProperty[] = [];
  if (inferredName !== undefined && !keys.has("name")) {
    inject.push(t.objectProperty(t.identifier("name"), t.stringLiteral(inferredName)));
  }
  if (spec.inject.includes("loc") && !keys.has("loc") && path.node.loc) {
    const loc = `${rel}:${path.node.loc.start.line}`;
    inject.push(t.objectProperty(t.identifier("loc"), t.stringLiteral(loc)));
  }
  if (spec.inject.includes("description") && !keys.has("description")) {
    const description = descriptionFromComments(binding.commentNode?.leadingComments);
    if (description !== undefined) {
      inject.push(t.objectProperty(t.identifier("description"), t.stringLiteral(description)));
    }
  }
  if (inject.length === 0) return;

  if (opts) {
    opts.properties.push(...inject);
  } else if (spec.optionsArg === args.length) {
    args.push(t.objectExpression(inject));
  }
  // optionsArg beyond appendable position with no object: structurally
  // impossible given the arity gate above; nothing to do.
}

/** Options for the standalone Vite plugin. */
export interface SourceLocatorViteOptions extends SourceLocatorOptions {
  /**
   * @internal Test seam — override how `@babel/core` is loaded. Defaults to a
   * dynamic `import("@babel/core")`.
   */
  loadBabel?: () => Promise<BabelModule>;
}

/** The content sniff: JSX open tag (when stamping) or a factory call. */
function buildSniff(factories: FactorySpec[], stampJsx: boolean): RegExp | undefined {
  const parts: string[] = [];
  if (stampJsx) parts.push("<[A-Za-z]");
  if (factories.length > 0) {
    const escaped = factories.map((f) => f.callee.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    parts.push(`\\b(?:${escaped.join("|")})\\s*\\(`);
  }
  return parts.length > 0 ? new RegExp(parts.join("|")) : undefined;
}

/**
 * The standalone Vite plugin — the recommended integration.
 *
 * Running our own babel pass (`enforce: "pre"`, before vite-plugin-solid)
 * instead of hooking vite-plugin-solid's `babel` option matters for two
 * reasons, both paid for: (1) vite-plugin-solid only transforms `.jsx/.tsx`, so
 * `cell()`/`control()` calls in plain `.ts` model files would never be
 * instrumented; (2) the decoupling means this works for ANY consumer, not just
 * Solid apps — the JSX stamping half applies to every JSX framework, and the
 * factory half to anything cell-shaped.
 *
 * Applies to **serve AND build**: factory identity injection is load-bearing
 * (a control's compiled-in name is its durable key and tool identity), so a
 * production build must run it too. JSX stamping remains dev-only by default
 * (`stampJsx` defaults to `command === "serve"`); pass `stampJsx: true` to
 * keep instrumentation in a production build deliberately.
 *
 * `node_modules` skipped; a cheap content sniff skips files with neither JSX
 * nor a factory call. `@babel/core` is loaded lazily (dynamic import) and
 * required only here — if it is missing, `buildStart` fails fast with a clear
 * install hint.
 */
export function sourceLocatorVite(options: SourceLocatorViteOptions = {}): Plugin {
  // Root defaults to the resolved Vite root (captured in configResolved); an
  // explicit option always wins. stampJsx defaults per-command (serve only).
  let root = options.root ?? "";
  let stampJsx = options.stampJsx ?? true;
  const factories = resolveFactories(options);
  let sniff = buildSniff(factories, stampJsx);

  const load = options.loadBabel ?? (() => import("@babel/core"));
  let babel: BabelModule | undefined;
  let pending: Promise<BabelModule> | undefined;
  const ensureBabel = (): Promise<BabelModule> => {
    if (babel) return Promise.resolve(babel);
    if (!pending) {
      pending = load().then(
        (mod) => {
          babel = mod;
          return mod;
        },
        () => {
          pending = undefined; // allow a later transform to retry the load
          throw new Error(LOAD_ERROR);
        },
      );
    }
    return pending;
  };

  return {
    name: "aiui:source-locator",
    enforce: "pre",
    configResolved(config) {
      if (options.root === undefined) root = config.root;
      if (options.stampJsx === undefined) stampJsx = config.command === "serve";
      sniff = buildSniff(factories, stampJsx);
    },
    async buildStart() {
      // Fail fast with a clear message if the optional peer is missing, rather
      // than mid-session on the first matching module.
      await ensureBabel();
    },
    async transform(code, id) {
      const file = id.replace(/\?.*$/, "");
      if (!/\.[mc]?[tj]sx?$/.test(file)) return null;
      if (file.includes("node_modules")) return null;
      if (root && !file.startsWith(root)) return null;
      if (!sniff?.test(code)) return null; // nothing to inject
      const { transformAsync } = await ensureBabel();
      // jsx parsing only for *.jsx/*.tsx: in plain .ts the jsx plugin makes
      // `<T>expr` type assertions ambiguous.
      const isJsxFile = /x$/.test(file);
      const plugins: ("jsx" | "typescript")[] = isJsxFile ? ["jsx", "typescript"] : ["typescript"];
      const result = await transformAsync(code, {
        filename: file,
        parserOpts: { plugins },
        plugins: [
          [sourceLocatorBabel, { root, factories, stampJsx } satisfies SourceLocatorOptions],
        ],
        configFile: false,
        babelrc: false,
        sourceMaps: true,
      });
      return result?.code ? { code: result.code, map: result.map as Rollup.SourceMapInput } : null;
    },
  };
}
