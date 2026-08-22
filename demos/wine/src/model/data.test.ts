/**
 * data.test.ts — the SQL builders (playbook layer 1): the classify CASE is
 * well-formed, escapes quotes, and assigns categories in list order with
 * "other" as the tail bucket.
 */
import { describe, expect, it } from "vitest";
import { classifySql, joinSql, TOP_VARIETIES_SQL } from "./data";

describe("joinSql", () => {
  it("reproduces Apple's deterministic id (row_number over md5(description))", () => {
    const sql = joinSql("wine");
    expect(sql).toContain("row_number() OVER (ORDER BY md5(description))");
    expect(sql).toContain("LEFT JOIN 'precomputed.parquet'");
    expect(sql).toContain("CREATE OR REPLACE TABLE wine_raw");
  });
});

describe("classifySql", () => {
  it("assigns 0-indexed categories in list order, everything else the tail", () => {
    const sql = classifySql("wine", ["Pinot Noir", "Riesling"]);
    expect(sql).toContain("WHEN variety = 'Pinot Noir' THEN 0");
    expect(sql).toContain("WHEN variety = 'Riesling' THEN 1");
    expect(sql).toContain("ELSE 2 END AS variety_cat");
    expect(sql).toContain("ELSE 'other' END AS variety_class");
  });

  it("escapes single quotes in variety names", () => {
    const sql = classifySql("wine", ["Nero d'Avola"]);
    expect(sql).toContain("'Nero d''Avola'");
  });
});

describe("TOP_VARIETIES_SQL", () => {
  it("ranks by count with a deterministic tiebreak", () => {
    expect(TOP_VARIETIES_SQL("wine")).toContain("ORDER BY count(*) DESC, variety LIMIT 9");
  });
});
