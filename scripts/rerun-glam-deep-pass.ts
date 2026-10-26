/**
 * Clear sales/products/events for glam 0845b494 and re-run segment→reconcile.
 * Keeps video, transcript, comments. No re-ASR.
 *
 * Usage: bun run ./scripts/rerun-glam-deep-pass.ts [recording-id]
 */
import { resolve } from "node:path";
import { createSql } from "@mezatizle/db";
import { summarizeOfferWindows, type TimelineEvent } from "@mezatizle/shared";
import {
  reconcileSales,
  segmentAuctionFromSignals,
} from "../apps/api/src/modules/auction_pipeline.ts";

const RECORDING_ID =
  process.argv[2] ?? "0845b494-3fb7-4e5c-9219-c772c24a1362";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://mezatizle:mezatizle@127.0.0.1:5433/mezatizle";

const storageRoot = resolve(
  process.env.STORAGE_ROOT ?? "/home/tolga/projects/mezatizle/storage",
);

const sql = createSql(databaseUrl);

const [rec] = await sql<
  {
    original_filename: string;
    duration_seconds: number | null;
    capture_status: string | null;
    status: string;
  }[]
>`
  SELECT original_filename, duration_seconds, capture_status, status
  FROM recordings WHERE id = ${RECORDING_ID}
`;
if (!rec) {
  console.error("missing recording", RECORDING_ID);
  process.exit(1);
}
console.log(
  "===",
  RECORDING_ID,
  rec.original_filename,
  "status=",
  rec.status,
  "capture=",
  rec.capture_status,
  "dur=",
  rec.duration_seconds,
);

const beforeSales = await sql<
  { status: string; n: number; try_sum: number }[]
>`
  SELECT status, COUNT(*)::int AS n,
         (COALESCE(SUM(amount_cents),0)::float/100) AS try_sum
  FROM sales WHERE recording_id = ${RECORDING_ID}
  GROUP BY status
`;
console.log("BEFORE sales", beforeSales);

const [beforeOffer] = await sql<{ events: number; comments: number; transcript: number }[]>`
  SELECT
    (SELECT COUNT(*)::int FROM auction_events WHERE recording_id = ${RECORDING_ID}) AS events,
    (SELECT COUNT(*)::int FROM observed_comments WHERE recording_id = ${RECORDING_ID}) AS comments,
    (SELECT COUNT(*)::int FROM transcript_segments WHERE recording_id = ${RECORDING_ID}) AS transcript
`;
console.log("BEFORE", beforeOffer);

const saleIds = await sql<{ id: string; product_id: string | null }[]>`
  SELECT id, product_id FROM sales WHERE recording_id = ${RECORDING_ID}
`;
const productIds = saleIds
  .map((s) => s.product_id)
  .filter((id): id is string => Boolean(id));
if (saleIds.length) {
  await sql`DELETE FROM sale_evidence WHERE sale_id IN ${sql(saleIds.map((s) => s.id))}`;
  await sql`DELETE FROM sales WHERE recording_id = ${RECORDING_ID}`;
}
if (productIds.length) {
  await sql`DELETE FROM products WHERE id IN ${sql(productIds)}`;
}
await sql`DELETE FROM auction_events WHERE recording_id = ${RECORDING_ID}`;
await sql`
  DELETE FROM processing_jobs
  WHERE recording_id = ${RECORDING_ID}
    AND job_type IN ('segment_auction', 'reconcile_sales')
`;
console.log("cleared sales/products/events/jobs");

const seg = await segmentAuctionFromSignals(sql, RECORDING_ID);
console.log("segment", seg);
const recap = await reconcileSales(sql, RECORDING_ID, storageRoot);
console.log("reconcile", recap);

const rows = await sql<
  {
    id: string;
    offset_ms: number | null;
    event_type: string;
    payload: Record<string, unknown> | null;
    confidence: number | null;
  }[]
>`
  SELECT id, offset_ms, event_type, payload, confidence FROM auction_events
  WHERE recording_id = ${RECORDING_ID}
  ORDER BY COALESCE(offset_ms, 0) ASC
`;
const timeline: TimelineEvent[] = rows.map((r) => {
  const p = r.payload ?? {};
  return {
    id: r.id,
    offsetMs: Number(r.offset_ms ?? 0),
    eventType: r.event_type as TimelineEvent["eventType"],
    source: p.source === "comment" ? "comment" : "transcript",
    amountTry:
      p.amountTry != null && Number.isFinite(Number(p.amountTry))
        ? Number(p.amountTry)
        : undefined,
    buyerHint: typeof p.buyerHint === "string" ? p.buyerHint : undefined,
    spokenBuyerName:
      typeof p.spokenBuyerName === "string" ? p.spokenBuyerName : undefined,
    matched: typeof p.matched === "string" ? p.matched : "",
    reason: typeof p.reason === "string" ? p.reason : undefined,
    productHint:
      typeof p.productHint === "string" ? p.productHint : undefined,
    lotNumber:
      p.lotNumber != null && Number.isFinite(Number(p.lotNumber))
        ? Number(p.lotNumber)
        : undefined,
    confidence: r.confidence ?? undefined,
  };
});
const offer = summarizeOfferWindows(timeline);

const afterSales = await sql<
  { status: string; n: number; try_sum: number }[]
>`
  SELECT status, COUNT(*)::int AS n,
         (COALESCE(SUM(amount_cents),0)::float/100) AS try_sum
  FROM sales WHERE recording_id = ${RECORDING_ID}
  GROUP BY status
`;
const methods = await sql<
  { method: string; status: string; n: number }[]
>`
  SELECT COALESCE(p.attributes->>'saleMethod','?') AS method, s.status, COUNT(*)::int AS n
  FROM sales s LEFT JOIN products p ON p.id = s.product_id
  WHERE s.recording_id = ${RECORDING_ID}
  GROUP BY 1,2 ORDER BY 2, n DESC
`;

console.log("\n=== AFTER ===");
console.log({
  productsOffered: offer.productsOffered,
  offeredSumTry: offer.offeredSumTry,
  sales: afterSales,
  methods,
});

await sql.end();
