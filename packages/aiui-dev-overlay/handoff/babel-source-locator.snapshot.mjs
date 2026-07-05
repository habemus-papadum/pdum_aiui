// SNAPSHOT (2026-07-05) of packages/aiui-demo/babel-source-locator.mjs —
// the living file is the canonical one; this copy rides with the handoff
// doc for convenience. See source-locator-and-cell-attribution.md.

/**
 * babel-source-locator.mjs — stamp every host JSX element with where it was
 * authored: `data-source-loc="src/ui/Controls.tsx:42:7"` (path relative to
 * the app root, 1-based line:column).
 *
 * This replaces LocatorJS for the agent workflow. Its babel plugin worked
 * with Solid 2.0 but emitted only `file::<element-index>` (line numbers live
 * in a side-table its 1.x-only runtime consumes); this emits the real
 * location directly, costs no dependency, and pairs with the plugin-seeded
 * `window.__AIUI__.sourceRoot` to give an agent absolute paths:
 *
 *   sourceRoot + "/" + el.dataset.sourceLoc  →  clickable file:line:col
 *
 * Only *host* elements (lowercase tags) are stamped — stamping a component
 * would just pass a mystery prop. Dev-only by wiring (vite.config.ts).
 *
 * Why the work happens in Program.enter rather than a JSXOpeningElement
 * visitor (paid-for finding): this runs in the same babel pass as
 * babel-preset-solid, whose compiler visits each outermost JSXElement,
 * compiles the whole subtree internally, and replaces it — so the shared
 * traversal never *descends* into JSX children, and a JSXOpeningElement
 * handler in another plugin simply never fires for them. Program.enter runs
 * before any element is replaced; an explicit `path.traverse` from there
 * sees the entire intact tree. (`@locator/babel-jsx` does the same thing,
 * for the same reason.)
 */
export default function sourceLocator({ types: t }, options = {}) {
  const root = options.root ?? "";
  const ATTR = "data-source-loc";
  return {
    name: "source-locator",
    visitor: {
      Program(programPath, state) {
        const file = state.file.opts.filename ?? "";
        const rel =
          root && file.startsWith(root) ? file.slice(root.length).replace(/^\//, "") : file;
        programPath.traverse({
          JSXOpeningElement(path) {
            const name = path.node.name;
            if (name.type !== "JSXIdentifier" || !/^[a-z]/.test(name.name)) return;
            if (!path.node.loc) return;
            const exists = path.node.attributes.some(
              (a) => a.type === "JSXAttribute" && a.name.name === ATTR,
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
          // syntactic (the callee must literally be `cell`) — a deliberate
          // 90% heuristic; aliased or re-exported factories won't be seen.
          CallExpression(path) {
            const callee = path.node.callee;
            if (callee.type !== "Identifier" || callee.name !== "cell") return;
            const args = path.node.arguments;
            if (args.length < 2 || args.length > 3 || !path.node.loc) return;

            // Infer the cell's name from where its value lands.
            let cellName;
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
            if (args.length === 2) {
              args.push(t.objectExpression([nameProp, locProp]));
            } else if (args[2].type === "ObjectExpression") {
              const keys = args[2].properties
                .filter((p) => p.type === "ObjectProperty" && p.key.type === "Identifier")
                .map((p) => p.key.name);
              if (!keys.includes("name")) args[2].properties.push(nameProp);
              if (!keys.includes("loc")) args[2].properties.push(locProp);
            } // a non-literal options expression is left alone
          },
        });
      },
    },
  };
}

// ---------------------------------------------------------------------------
// The standalone Vite plugin — the recommended integration.
//
// Running our own babel pass (enforce: "pre", before vite-plugin-solid)
// instead of hooking vite-plugin-solid's `babel` option matters for two
// reasons, both paid for: (1) vite-plugin-solid only transforms .jsx/.tsx, so
// cell() calls in plain .ts model files would never be instrumented; (2) the
// decoupling means this works for ANY consumer, not just Solid apps — the
// JSX stamping half applies to every JSX framework, and the cell() half to
// anything cell-shaped. Dev-server-only; node_modules skipped; a cheap
// content sniff skips files with neither JSX nor cell() calls.
// ---------------------------------------------------------------------------
import { transformAsync } from "@babel/core";

export function sourceLocatorVite(options = {}) {
  const root = options.root ?? "";
  return {
    name: "aiui:source-locator",
    enforce: "pre",
    apply: "serve",
    async transform(code, id) {
      const file = id.replace(/\?.*$/, "");
      if (!/\.[mc]?[tj]sx?$/.test(file)) return null;
      if (file.includes("node_modules")) return null;
      if (root && !file.startsWith(root)) return null;
      if (!/<[A-Za-z]|\bcell\s*\(/.test(code)) return null; // nothing to stamp
      // jsx parsing only for *.jsx/*.tsx: in plain .ts the jsx plugin makes
      // `<T>expr` type assertions ambiguous.
      const isJsxFile = /x$/.test(file.replace(/\?.*$/, ""));
      const result = await transformAsync(code, {
        filename: file,
        parserOpts: { plugins: isJsxFile ? ["jsx", "typescript"] : ["typescript"] },
        plugins: [[sourceLocator, { root }]],
        configFile: false,
        babelrc: false,
        sourceMaps: true,
      });
      return result?.code ? { code: result.code, map: result.map } : null;
    },
  };
}
