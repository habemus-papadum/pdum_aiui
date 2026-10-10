import { createHash } from "node:crypto";
import { relative } from "node:path";
import MagicString from "magic-string";
import { parseSync } from "vite";

type SyntaxNode = { type: string; start: number; end: number; [key: string]: unknown };

function isNode(value: unknown): value is SyntaxNode {
  return (
    value !== null &&
    typeof value === "object" &&
    "type" in value &&
    typeof value.type === "string" &&
    "start" in value &&
    typeof value.start === "number" &&
    "end" in value &&
    typeof value.end === "number"
  );
}

function walk(node: SyntaxNode, visit: (node: SyntaxNode, parent?: SyntaxNode) => void) {
  function descend(current: SyntaxNode, parent?: SyntaxNode) {
    visit(current, parent);
    for (const value of Object.values(current)) {
      if (Array.isArray(value)) {
        for (const item of value) if (isNode(item)) descend(item, current);
      } else if (isNode(value)) descend(value, current);
    }
  }
  descend(node);
}

/**
 * Capture source owners, not a source-to-output character map.
 *
 * Oxc's public JS AST uses UTF-16 offsets. Ranges refer to the unmodified file,
 * include the complete JSX element/fragment or child expression, and exclude
 * the interpolation's braces. A source resolver must match `revision` before
 * presenting a range as current source. Source text is not stored in the record.
 */
export function instrumentPromptSource(code: string, file: string, root: string) {
  const parsed = parseSync(file, code);
  if (parsed.errors.length) throw new Error(`${file}: cannot instrument invalid prompt TSX`);
  const program = parsed.program as unknown as SyntaxNode;
  const names = new Set<string>();
  walk(program, (node) => {
    if (
      (node.type === "Identifier" || node.type === "JSXIdentifier") &&
      typeof node.name === "string"
    ) {
      names.add(node.name);
    }
  });
  let helper = "__aiuiPromptOrigin";
  while (names.has(helper)) helper += "_";

  const edits = new MagicString(code);
  const revision = `sha256:${createHash("sha256").update(code, "utf8").digest("hex")}`;
  const source = relative(root, file).replaceAll("\\", "/");
  const origin = (node: SyntaxNode, site: "construction" | "interpolation") =>
    JSON.stringify({
      kind: "source",
      file: source,
      revision,
      span: { start: node.start, end: node.end },
      site,
      precision: "owner",
    });
  let usesHelper = false;
  function wrap(node: SyntaxNode, site: "construction" | "interpolation", jsxChild = false) {
    usesHelper = true;
    // The runtime helper preserves array/item boundaries and records nested
    // owner lineage without adding semantic grouping nodes.
    edits.appendLeft(node.start, `${jsxChild ? "{" : ""}${helper}((`);
    edits.prependRight(node.end, `),${origin(node, site)})${jsxChild ? "}" : ""}`);
  }

  walk(program, (node, parent) => {
    if (node.type === "JSXElement") {
      const opening = node.openingElement as SyntaxNode;
      for (const attribute of opening.attributes as SyntaxNode[]) {
        if (attribute.type === "JSXAttribute") {
          const name = attribute.name as SyntaxNode;
          if (name.name === "__promptOrigin") {
            throw new Error(
              `${file}: __promptOrigin is reserved for prompt source instrumentation`,
            );
          }
        }
      }
      edits.appendLeft(
        opening.end - (opening.selfClosing ? 2 : 1),
        ` __promptOrigin={${origin(node, "construction")}}`,
      );
    } else if (node.type === "JSXFragment") {
      wrap(node, "construction", parent?.type === "JSXElement" || parent?.type === "JSXFragment");
    } else if (node.type === "JSXExpressionContainer") {
      const expression = node.expression as SyntaxNode;
      const childrenAttribute =
        parent?.type === "JSXAttribute" && (parent.name as SyntaxNode).name === "children";
      if (
        expression.type !== "JSXEmptyExpression" &&
        (parent?.type === "JSXElement" || parent?.type === "JSXFragment" || childrenAttribute)
      ) {
        wrap(expression, "interpolation");
      }
    }
  });

  if (usesHelper) {
    // Preserve shebangs and directive prologues. Use a lexical alias that cannot
    // shadow any identifier in this module, including a nested component scope.
    let at = code.startsWith("#!") ? code.indexOf("\n") + 1 : 0;
    for (const statement of program.body as SyntaxNode[]) {
      if (statement.type !== "ExpressionStatement" || typeof statement.directive !== "string")
        break;
      at = statement.end;
    }
    edits.appendLeft(
      at,
      `\nimport { withPromptOrigin as ${helper} } from "@habemus-papadum/aiui-prompts/jsx-runtime";\n`,
    );
  }
  return {
    code: edits.toString(),
    map: edits.generateMap({ source: file, includeContent: true, hires: true }),
  };
}
