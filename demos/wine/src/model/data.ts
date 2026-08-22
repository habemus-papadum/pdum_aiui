/**
 * data.ts — the wine-reviews dataset, exactly the recipe Embedding Atlas's own
 * wine demo uses (apple/embedding-atlas, packages/docs/examples/datasets.js):
 * the WineEnthusiast reviews parquet from HuggingFace joined against a
 * PRECOMPUTED embedding parquet Apple hosts (per-row x/y of a text-embedding
 * projection of the tasting notes, keyed by `row_number() OVER (ORDER BY
 * md5(description))` — the join only works if our dedup/ordering matches
 * theirs byte for byte, so the SQL below reproduces it verbatim).
 *
 * ~64 MB across the two files — far past the vendor-in-the-package budget
 * (seismos ships 4 MB), so they are fetched at runtime and kept in the Cache
 * API — see fetch-cache.ts; this module is pure (URLs + SQL builders) so the
 * recipe is unit-testable without touching DuckDB.
 */

/** WineEnthusiast reviews (~130k rows) — HuggingFace spawn99/wine-reviews,
 * CC BY-NC-SA 4.0, pinned to the exact revision Apple's demo embeds. */
export const REVIEWS_URL =
  "https://huggingface.co/datasets/spawn99/wine-reviews/resolve/e6b10f4db3091a6fed8c5b294c0cc885e7f6e99d/data/train-00000-of-00001.parquet";

/** Apple's precomputed projection of the tasting-note embeddings (id, x, y,
 * neighbors), published beside their docs' wine example. */
export const PROJECTION_URL =
  "https://apple.github.io/embedding-atlas/examples/cache/20687671.parquet";

/** Approximate download weights (MB) for a combined progress fraction. */
export const REVIEWS_MB = 40;
export const PROJECTION_MB = 24;

/**
 * The table build, Apple's SQL with two additions at the end: `variety_class`
 * (the top-9 varieties by review count, everything else "other") and
 * `variety_cat` (that class as a 0-indexed integer — EmbeddingViewMosaic's
 * category contract). Returns the class names in category order.
 */
export function joinSql(table: string): string {
  return `
    CREATE OR REPLACE TABLE ${table}_raw AS
    SELECT dataset.*, p.x AS projection_x, p.y AS projection_y
    FROM (
      SELECT row_number() OVER (ORDER BY md5(description)) AS id,
             title, country, province, description, points, price, variety, designation,
             any_value(region_1) AS region_1, any_value(region_2) AS region_2,
             any_value(winery) AS winery
      FROM 'dataset.parquet'
      GROUP BY title, country, province, description, points, price, variety, designation
      ORDER BY md5(description)
    ) AS dataset
    LEFT JOIN 'precomputed.parquet' AS p ON dataset.id = p.id`;
}

export const TOP_VARIETIES_SQL = (table: string): string =>
  `SELECT variety FROM ${table}_raw WHERE variety IS NOT NULL
   GROUP BY variety ORDER BY count(*) DESC, variety LIMIT 9`;

/** Escape a single-quoted SQL string literal. */
const q = (s: string): string => `'${s.replaceAll("'", "''")}'`;

export function classifySql(table: string, topVarieties: readonly string[]): string {
  const catCase = topVarieties.map((v, i) => `WHEN variety = ${q(v)} THEN ${i}`).join("\n      ");
  const inList = topVarieties.map(q).join(", ");
  return `
    CREATE OR REPLACE TABLE ${table} AS
    SELECT *,
      CASE ${catCase} ELSE ${topVarieties.length} END AS variety_cat,
      CASE WHEN variety IN (${inList}) THEN variety ELSE 'other' END AS variety_class
    FROM ${table}_raw`;
}

/** The curated (country, province) → lat/lon lookup (src/data/provinces.json,
 * registered as a DuckDB file) becomes a real table for the geo join. */
export const PROVINCE_GEO_SQL =
  "CREATE OR REPLACE TABLE province_geo AS SELECT country, province, lat, lon FROM read_json('provinces.json')";

/**
 * The geographic columns: join each review to its province centroid, add a
 * deterministic per-row jitter (~±0.35° lat, ±0.45° lon, hashed from the row
 * id) so a province's thousands of reviews read as a cloud instead of one
 * stacked point, then bake the Equal-Earth projection into eq_x/eq_y — the
 * map's raster and brush work in projected space with linear scales (the
 * seismos pattern; JS mirror in geo.ts). Unplaced rows keep NULLs and simply
 * don't appear on the map.
 */
export function geoSql(table: string): string {
  return `
    CREATE OR REPLACE TABLE ${table} AS
    SELECT * EXCLUDE (ee_theta),
      RADIANS(longitude) * COS(ee_theta) * 1.1547005383792515
        / (1.340264 + 3*-0.081106*ee_theta*ee_theta
           + POWER(ee_theta, 6) * (7*0.000893 + 9*0.003796*ee_theta*ee_theta)) AS eq_x,
      ee_theta * (1.340264 + -0.081106*ee_theta*ee_theta
           + POWER(ee_theta, 6) * (0.000893 + 0.003796*ee_theta*ee_theta)) AS eq_y
    FROM (
      SELECT *, ASIN(0.8660254037844386 * SIN(RADIANS(latitude))) AS ee_theta
      FROM (
        SELECT w.*,
          g.lat + ((hash(w.id) % 1000) / 999.0 - 0.5) * 0.7 AS latitude,
          g.lon + ((hash(w.id + 7777777) % 1000) / 999.0 - 0.5) * 0.9 AS longitude
        FROM ${table} AS w
        LEFT JOIN province_geo AS g
          ON w.country = g.country AND w.province = g.province
      )
    )`;
}
