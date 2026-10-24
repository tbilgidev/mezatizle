/**
 * Attach missing products/<id>.jpg for sales on a recording (or all missing).
 * Does not wipe sales — only updates attributes.imagePath.
 *
 * Usage:
 *   bun run ./scripts/backfill-product-thumbs.ts [recording-id|all]
 */
import { resolve } from "node:path";
import { createSql } from "@mezatizle/db";
import { attachProductImage } from "../apps/api/src/modules/auction_pipeline.ts";

const RECORDING_ID = process.argv[2] ?? "42577ec1-c50c-45fa-9691-362b417d7312";
const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://mezatizle:mezatizle@127.0.0.1:5433/mezatizle";
const storageRoot = resolve(
  process.env.STORAGE_ROOT ?? "/home/tolga/projects/mezatizle/storage",
);

const sql = createSql(databaseUrl);

const rows =
  RECORDING_ID === "all"
    ? await sql<
        {
          product_id: string;
          recording_id: string;
          offset_ms: string | null;
          storage_path: string | null;
          duration_seconds: number | null;
          image_path: string | null;
        }[]
      >`
      SELECT
        p.id AS product_id,
        s.recording_id,
        p.attributes->>'offsetMs' AS offset_ms,
        r.storage_path,
        r.duration_seconds,
        p.attributes->>'imagePath' AS image_path
      FROM sales s
      JOIN products p ON p.id = s.product_id
      JOIN recordings r ON r.id = s.recording_id
      WHERE
        p.attributes->>'imagePath' IS NULL
        OR TRIM(COALESCE(p.attributes->>'imagePath', '')) = ''
      ORDER BY s.recording_id, COALESCE((p.attributes->>'offsetMs')::float, 0)
    `
    : await sql<
        {
          product_id: string;
          recording_id: string;
          offset_ms: string | null;
          storage_path: string | null;
          duration_seconds: number | null;
          image_path: string | null;
        }[]
      >`
      SELECT
        p.id AS product_id,
        s.recording_id,
        p.attributes->>'offsetMs' AS offset_ms,
        r.storage_path,
        r.duration_seconds,
        p.attributes->>'imagePath' AS image_path
      FROM sales s
      JOIN products p ON p.id = s.product_id
      JOIN recordings r ON r.id = s.recording_id
      WHERE s.recording_id = ${RECORDING_ID}
        AND (
          p.attributes->>'imagePath' IS NULL
          OR TRIM(COALESCE(p.attributes->>'imagePath', '')) = ''
        )
      ORDER BY COALESCE((p.attributes->>'offsetMs')::float, 0)
    `;

console.log(
  JSON.stringify(
    {
      storageRoot,
      recordingFilter: RECORDING_ID,
      missing: rows.length,
    },
    null,
    2,
  ),
);

let ok = 0;
let fail = 0;
const sampleOk: string[] = [];
for (const row of rows) {
  const offsetMs =
    row.offset_ms != null && Number.isFinite(Number(row.offset_ms))
      ? Number(row.offset_ms)
      : null;
  const videoPath = row.storage_path
    ? row.storage_path.startsWith("/")
      ? row.storage_path
      : resolve(storageRoot, row.storage_path)
    : null;
  const durationSeconds =
    row.duration_seconds != null && Number.isFinite(Number(row.duration_seconds))
      ? Number(row.duration_seconds)
      : null;

  const imagePath = await attachProductImage(
    storageRoot,
    row.recording_id,
    row.product_id,
    offsetMs,
    { durationSeconds, videoPath },
  );
  if (!imagePath) {
    fail++;
    console.warn("fail", row.product_id, "offset", offsetMs);
    continue;
  }
  await sql`
    UPDATE products
    SET attributes = attributes || ${sql.json({ imagePath })}::jsonb,
        updated_at = now()
    WHERE id = ${row.product_id}
  `;
  ok++;
  if (sampleOk.length < 8) sampleOk.push(`${row.product_id} → ${imagePath}`);
}

console.log(
  JSON.stringify({ ok, fail, sampleOk }, null, 2),
);

await sql.end();
