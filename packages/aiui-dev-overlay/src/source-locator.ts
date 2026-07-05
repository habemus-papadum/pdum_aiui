/**
 * Compile-time source-location stamping + element→cell attribution, absorbed
 * into the dev overlay from the demo's `babel-source-locator.mjs`. Node-side
 * only (behind the `./vite` subpath): the browser bundle never imports this.
 *
 * Two concerns, both dev-server-only:
 *
 *  1. **JSX stamping** — every *host* JSX element gets
 *     `data-source-loc="src/ui/Controls.tsx:42:7"` (path relative to the app
 *     root, 1-based line:column). Paired with the overlay's injected
 *     `window.__AIUI__.sourceRoot`, `sourceRoot + "/" + el.dataset.sourceLoc`
 *     is an absolute, clickable `file:line:col`. Only host elements (lowercase
 *     tags) are stamped — stamping a component would just pass a mystery prop.
 *
 *  2. **cell() call-site identity** — a call to a configured factory
 *     (`cellFactories`, default `["cell"]`) has a third argument injected:
 *     `cell(deps, compute)` → `cell(deps, compute, { name, loc })`, with the
 *     name inferred from where the value lands. Zero affordance in user code:
 *     the cell registry and CellView's `data-cell` stamp are driven entirely by
 *     this injection. An empty `cellFactories` disables this half.
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

export interface SourceLocatorOptions {
  /**
   * App root for relativizing filenames; a stamped/injected path is
   * `file.slice(root.length)`. Defaults to `""` (absolute paths).
   */
  root?: string;
  /**
   * Callee names treated as cell factories for call-site identity injection.
   * Default `["cell"]`; an empty array disables the call-site half entirely
   * (JSX stamping is independent of this). Naming is syntactic — the callee
   * must literally be one of these identifiers; aliased factories are invisible.
   */
  cellFactories?: string[];
}

/**
 * The babel plugin (both halves). Kept a plain function so it can be dropped
 * into any `@babel/core` `plugins` array — the standalone {@link sourceLocatorVite}
 * pass, or a consumer's existing babel pass at real-app scale.
 *
 * Why the work happens in `Program.enter` rather than a `JSXOpeningElement`
 * visitor (paid-for finding): this runs in the same babel pass as
 * babel-preset-solid, whose compiler visits each outermost `JSXElement`,
 * compiles the whole subtree internally, and replaces it — so the shared
 * traversal never *descends* into JSX children, and a `JSXOpeningElement`
 * handler in another plugin simply never fires for them. `Program.enter` runs
 * before any element is replaced; an explicit `path.traverse` from there sees
 * the entire intact tree. (`@locator/babel-jsx` does the same thing, for the
 * same reason.)
 */
export function sourceLocatorBabel(
  babel: { types: typeof BabelTypes },
  options: SourceLocatorOptions = {},
): PluginObj {
  const t = babel.types;
  const root = options.root ?? "";
  const cellFactories = new Set(options.cellFactories ?? ["cell"]);
  return {
    name: "aiui-source-locator",
    visitor: {
      Program(programPath: NodePath<BabelTypes.Program>, state: PluginPass) {
        const file = state.file.opts.filename ?? "";
        const rel =
          root && file.startsWith(root) ? file.slice(root.length).replace(/^\//, "") : file;
        const visitor: Visitor = {
          JSXOpeningElement(path) {
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

          // ---- cell() call-site identity (element → cell attribution) ------
          //
          // `const catalog = cell(deps, compute)` becomes
          // `const catalog = cell(deps, compute, { name: "catalog", loc: "src/…:77" })`
          // — zero affordance in user code; the cell registry and CellView's
          // data-cell stamp are driven entirely by this injection. Naming is
          // syntactic (the callee must literally be a configured factory) — a
          // deliberate 90% heuristic; aliased or re-exported factories won't be
          // seen. An empty cellFactories set makes this a no-op.
          CallExpression(path) {
            if (cellFactories.size === 0) return;
            const callee = path.node.callee;
            if (callee.type !== "Identifier" || !cellFactories.has(callee.name)) return;
            const args = path.node.arguments;
            if (args.length < 2 || args.length > 3 || !path.node.loc) return;

            // Infer the cell's name from where its value lands.
            let cellName: string | undefined;
            const parent = path.parent;
            if (parent.type === "VariableDeclarator" && parent.id.type === "Identifier") {
              cellName = parent.id.name;
            } else if (parent.type === "ObjectProperty" && parent.key.type === "Identifier") {
              cellName = parent.key.name;
            } else if (
              parent.type === "AssignmentExpression" &&
              parent.left.type === "Identifier"
            ) {
              cellName = parent.left.name;
            }
            if (!cellName) return; // anonymous cells stay anonymous

            const loc = `${rel}:${path.node.loc.start.line}`;
            const nameProp = t.objectProperty(t.identifier("name"), t.stringLiteral(cellName));
            const locProp = t.objectProperty(t.identifier("loc"), t.stringLiteral(loc));
            const opts = args[2];
            if (args.length === 2) {
              args.push(t.objectExpression([nameProp, locProp]));
            } else if (opts.type === "ObjectExpression") {
              const keys = opts.properties
                .filter((p) => p.type === "ObjectProperty" && p.key.type === "Identifier")
                .map((p) => (p as BabelTypes.ObjectProperty).key as BabelTypes.Identifier)
                .map((k) => k.name);
              if (!keys.includes("name")) opts.properties.push(nameProp);
              if (!keys.includes("loc")) opts.properties.push(locProp);
            } // a non-literal options expression is left alone
          },
        };
        programPath.traverse(visitor);
      },
    },
  };
}

/** Options for the standalone Vite plugin. */
export interface SourceLocatorViteOptions extends SourceLocatorOptions {
  /**
   * @internal Test seam — override how `@babel/core` is loaded. Defaults to a
   * dynamic `import("@babel/core")`.
   */
  loadBabel?: () => Promise<BabelModule>;
}

/** Build the content sniff for the given factories: JSX open tag, or a factory call. */
function buildSniff(cellFactories: string[]): RegExp {
  const jsx = "<[A-Za-z]";
  if (cellFactories.length === 0) return new RegExp(jsx);
  const escaped = cellFactories.map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`${jsx}|\\b(?:${escaped.join("|")})\\s*\\(`);
}

/**
 * The standalone Vite plugin — the recommended integration.
 *
 * Running our own babel pass (`enforce: "pre"`, before vite-plugin-solid)
 * instead of hooking vite-plugin-solid's `babel` option matters for two
 * reasons, both paid for: (1) vite-plugin-solid only transforms `.jsx/.tsx`, so
 * `cell()` calls in plain `.ts` model files would never be instrumented; (2)
 * the decoupling means this works for ANY consumer, not just Solid apps — the
 * JSX stamping half applies to every JSX framework, and the `cell()` half to
 * anything cell-shaped. Dev-server-only; `node_modules` skipped; a cheap
 * content sniff skips files with neither JSX nor a factory call.
 *
 * `@babel/core` is loaded lazily (dynamic import) and required only here — if
 * it is missing, `buildStart` fails fast with a clear install hint.
 */
export function sourceLocatorVite(options: SourceLocatorViteOptions = {}): Plugin {
  // Root defaults to the resolved Vite root (captured in configResolved); an
  // explicit option always wins.
  let root = options.root ?? "";
  const cellFactories = options.cellFactories ?? ["cell"];
  const sniff = buildSniff(cellFactories);

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
    apply: "serve",
    configResolved(config) {
      if (options.root === undefined) root = config.root;
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
      if (!sniff.test(code)) return null; // nothing to stamp
      const { transformAsync } = await ensureBabel();
      // jsx parsing only for *.jsx/*.tsx: in plain .ts the jsx plugin makes
      // `<T>expr` type assertions ambiguous.
      const isJsxFile = /x$/.test(file);
      const plugins: ("jsx" | "typescript")[] = isJsxFile ? ["jsx", "typescript"] : ["typescript"];
      const result = await transformAsync(code, {
        filename: file,
        parserOpts: { plugins },
        plugins: [[sourceLocatorBabel, { root, cellFactories } satisfies SourceLocatorOptions]],
        configFile: false,
        babelrc: false,
        sourceMaps: true,
      });
      return result?.code ? { code: result.code, map: result.map as Rollup.SourceMapInput } : null;
    },
  };
}
