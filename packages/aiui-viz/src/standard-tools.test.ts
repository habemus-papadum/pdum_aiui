// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { agentToolkit } from "./agent-tools";
import { cell, cellGraph } from "./cell";
import { registerStandardTools } from "./standard-tools";

describe("registerStandardTools", () => {
  it("registers `locate` and the `cells` report section", () => {
    const kit = agentToolkit("stdSmoke");
    registerStandardTools(kit);

    const handle = kit.handle();
    expect(handle.tools.map((t) => t.name)).toContain("locate");
    expect(handle.report()).toHaveProperty("cells");
  });

  it("is idempotent — a re-evaluated module replaces rather than duplicates", () => {
    const kit = agentToolkit("stdSmokeIdem");
    registerStandardTools(kit);
    registerStandardTools(kit);
    expect(kit.handle().tools.filter((t) => t.name === "locate")).toHaveLength(1);
  });

  it("`locate` resolves an element to its source and cell stamps", () => {
    document.body.innerHTML = `
      <div data-cell="rose" data-cell-loc="src/model/graph.ts:31">
        <p data-source-loc="src/ui/Picture.tsx:12:4"><span id="leaf">petals</span></p>
      </div>`;

    const kit = agentToolkit("stdSmokeLocate");
    registerStandardTools(kit);
    const [hit] = kit.handle().call("locate", { selector: "#leaf" }) as Array<{
      tag: string;
      text: string;
      source: string | null;
      cell: string | null;
    }>;

    expect(hit.tag).toBe("span");
    expect(hit.text).toBe("petals");
    // `closest` walks up: the source stamp is on the <p>, the cell stamp on the
    // wrapping <div> that CellView rendered.
    expect(hit.source).toBe("src/ui/Picture.tsx:12:4");
    expect(hit.cell).toBe("rose");
  });

  it("the `cells` reporter is the live attribution table", () => {
    const kit = agentToolkit("stdSmokeCells");
    registerStandardTools(kit);

    const { dispose } = cellGraph(() =>
      cell(
        () => ({}),
        () => 1,
        { name: "temperature", loc: "g.ts:3" },
      ),
    );
    const report = kit.handle().report() as { cells: Array<{ name: string; loc?: string }> };
    expect(report.cells.map((c) => c.name)).toContain("temperature");

    // Cells deregister with their owner, so a disposed graph leaves no trace.
    dispose();
    const after = kit.handle().report() as { cells: Array<{ name: string }> };
    expect(after.cells.map((c) => c.name)).not.toContain("temperature");
  });
});
