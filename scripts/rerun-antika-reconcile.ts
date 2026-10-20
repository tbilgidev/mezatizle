/**
 * Re-segment + reconcile antikaadunyam gold reference only.
 * Does not touch live comments or other recordings.
 */
import { createSql } from "@mezatizle/db";
import {
  reconcileSales,
  segmentAuctionFromSignals,
} from "../apps/api/src/modules/auction_pipeline.ts";

const RID =
  process.env.RECORDING_ID ?? "52cd681e-7967-42ae-b843-449f7c063cdf";
const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://mezatizle:mezatizle@127.0.0.1:5433/mezatizle";
const storageRoot = process.env.STORAGE_ROOT ?? "./storage";

const sql = createSql(databaseUrl);

const [rec] = await sql<{ original_filename: string; status: string }[]>`
  SELECT original_filename, status FROM recordings WHERE id = ${RID}
`;
if (!rec) {
  console.error("missing recording", RID);
  process.exit(1);
}
console.log("===", RID, rec.original_filename, rec.status);

const beforeComments = await sql<{ n: string }[]>`
  SELECT COUNT(*)::text AS n FROM observed_comments WHERE recording_id = ${RID}
`;
console.log("comments_before", beforeComments[0]?.n);

const seg = await segmentAuctionFromSignals(sql, RID);
console.log("segment", seg);
const recap = await reconcileSales(sql, RID, storageRoot);
console.log("reconcile", recap);

const afterComments = await sql<{ n: string }[]>`
  SELECT COUNT(*)::text AS n FROM observed_comments WHERE recording_id = ${RID}
`;
console.log("comments_after", afterComments[0]?.n);

const [counts] = await sql<
  { sold: string; bid: string; price: string; sales: string }[]
>`
  SELECT
    (SELECT COUNT(*)::text FROM auction_events WHERE recording_id = ${RID} AND event_type = 'sold') AS sold,
    (SELECT COUNT(*)::text FROM auction_events WHERE recording_id = ${RID} AND event_type = 'bid') AS bid,
    (SELECT COUNT(*)::text FROM auction_events WHERE recording_id = ${RID} AND event_type = 'price_mention') AS price,
    (SELECT COUNT(*)::text FROM sales WHERE recording_id = ${RID}) AS sales
`;
console.log("counts", counts);

await sql.end?.();
process.exit(0);
