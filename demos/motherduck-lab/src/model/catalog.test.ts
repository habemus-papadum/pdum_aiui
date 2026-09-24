import { describe, expect, it } from "vitest";
import {
  createViewSql,
  hybridCountSql,
  isNumericType,
  isUserTable,
  LOCAL_SAMPLE,
  materializeSql,
  parseTableRefKey,
  qualifiedRef,
  sqlRef,
  tableRefKey,
  viewNameFor,
} from "./catalog";

const ref = { catalog: "shop", schema: "main", table: "orders" };

describe("table naming", () => {
  it("round-trips the dotted key and yields the array form Mosaic qualifies", () => {
    expect(tableRefKey(ref)).toBe("shop.main.orders");
    expect(parseTableRefKey("shop.main.orders")).toEqual(ref);
    expect(parseTableRefKey("orders")).toBeUndefined();
    expect(parseTableRefKey("shop..orders")).toBeUndefined();
    expect(qualifiedRef(ref)).toEqual(["shop", "main", "orders"]);
    expect(viewNameFor({ catalog: "my-db", schema: "main", table: "t.1" })).toBe(
      "my_db__main__t_1",
    );
    expect(createViewSql(ref)).toBe(
      'CREATE OR REPLACE VIEW "shop__main__orders" AS SELECT * FROM "shop"."main"."orders"',
    );
    expect(sqlRef({ catalog: 'we"ird', schema: "main", table: "t" })).toBe('"we""ird"."main"."t"');
  });

  it("offers user tables only: no system catalogs, no cube schema, not the sample itself", () => {
    const row = (c: string, s: string, t: string) => ({
      table_catalog: c,
      table_schema: s,
      table_name: t,
      table_type: "BASE TABLE",
    });
    expect(isUserTable(row("shop", "main", "orders"))).toBe(true);
    expect(isUserTable(row("memory", "main", "picks"))).toBe(true);
    expect(isUserTable(row("memory", "mosaic", "preagg_1"))).toBe(false);
    expect(isUserTable(row("md_information_schema", "main", "query_history"))).toBe(false);
    expect(isUserTable(row("system", "main", "x"))).toBe(false);
    expect(isUserTable(row("memory", "main", LOCAL_SAMPLE))).toBe(false);
  });
});

describe("types and SQL", () => {
  it("bins numeric types only", () => {
    for (const t of [
      "DOUBLE",
      "FLOAT",
      "DECIMAL(18,3)",
      "INTEGER",
      "BIGINT",
      "UINTEGER",
      "HUGEINT",
    ]) {
      expect(isNumericType(t)).toBe(true);
    }
    for (const t of ["VARCHAR", "TIMESTAMP WITH TIME ZONE", "BOOLEAN", "DATE", "INTERVAL"]) {
      expect(isNumericType(t)).toBe(false);
    }
  });

  it("materializes a bounded slice and asks the hybrid question across both sides", () => {
    expect(materializeSql(ref, 50_000.7)).toBe(
      'CREATE OR REPLACE TABLE "local_sample" AS SELECT * FROM "shop"."main"."orders" LIMIT 50000',
    );
    expect(materializeSql(ref, 0)).toContain("LIMIT 1");
    expect(hybridCountSql(ref, "amount")).toBe(
      'SELECT count(*) AS n FROM "shop"."main"."orders" r WHERE r."amount" BETWEEN ' +
        '(SELECT min("amount") FROM "local_sample") AND (SELECT max("amount") FROM "local_sample")',
    );
  });
});
