/**
 * Clear + re-run segment_auction + reconcile_sales for yesilkoyantika_ keepers.
 * Usage: bun run scripts/rerun-reconcile-keepers.ts
 */
import { createSql } from "@mezatizle/db";
import {
  reconcileSales,
  segmentAuctionFromSignals,
} from "../apps/api/src/modules/auction_pipeline.ts";

const KEEPERS = [
  "6c7e9508-5162-4d9f-955d-d12c6fa195bc",
  "99b0f63c-94d7-4a63-a746-257bb5589a8e",
];

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://mezatizle:mezatizle@127.0.0.1:5433/mezatizle";
const storageRoot = process.env.STORAGE_ROOT ?? "./storage";

const sql = createSql(databaseUrl);

for (const id of KEEPERS) {
  const [rec] = await sql<{ original_filename: string }[]>`
    SELECT original_filename FROM recordings WHERE id = ${id}
  `;
  if (!rec) {
    console.error("missing recording", id);
    continue;
  }
  console.log("===", id, rec.original_filename);
  const seg = await segmentAuctionFromSignals(sql, id);
  console.log("segment", seg);
  const recap = await reconcileSales(sql, id, storageRoot);
  console.log("reconcile", recap);
  const [counts] = await sql<
    { sold: string; bid: string; sales: string; with_img: string }[]
  >`
    SELECT
      (SELECT COUNT(*)::text FROM auction_events WHERE recording_id = ${id} AND event_type = 'sold') AS sold,
      (SELECT COUNT(*)::text FROM auction_events WHERE recording_id = ${id} AND event_type = 'bid') AS bid,
      (SELECT COUNT(*)::text FROM sales WHERE recording_id = ${id}) AS sales,
      (SELECT COUNT(*)::text FROM sales sa
        JOIN products p ON p.id = sa.product_id
        WHERE sa.recording_id = ${id}
          AND p.attributes ? 'imagePath') AS with_img
  `;
  console.log("counts", counts);
}

await sql.end?.();
process.exit(0);
