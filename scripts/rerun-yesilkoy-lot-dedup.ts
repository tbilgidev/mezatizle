/**
 * Re-segment + reconcile Yeşilköy Antika recording; print offer KPIs.
 * Keeps transcript + comments. Usage: bun run scripts/rerun-yesilkoy-lot-dedup.ts
 */
import { createSql } from "@mezatizle/db";
import { summarizeOfferWindows, type TimelineEvent } from "@mezatizle/shared";
import {
  reconcileSales,
  segmentAuctionFromSignals,
} from "../apps/api/src/modules/auction_pipeline.ts";

const RECORDING_ID =
  process.argv[2] ?? "8dcb0555-f015-49f1-9f8e-2205270a1aff";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://mezatizle:mezatizle@127.0.0.1:5432/mezatizle";
const storageRoot = process.env.STORAGE_ROOT ?? "./storage";

const sql = createSql(databaseUrl);

const [rec] = await sql<
  { original_filename: string; duration_seconds: number | null }[]
>`
  SELECT original_filename, duration_seconds FROM recordings WHERE id = ${RECORDING_ID}
`;
if (!rec) {
  console.error("missing recording", RECORDING_ID);
  process.exit(1);
}
console.log("===", RECORDING_ID, rec.original_filename, "dur=", rec.duration_seconds);

const beforeEvents = await sql<{ n: string }[]>`
  SELECT COUNT(*)::text AS n FROM auction_events
  WHERE recording_id = ${RECORDING_ID}
    AND event_type IN ('price_mention', 'item_intro')
`;
const beforeSales = await sql<{ n: string }[]>`
  SELECT COUNT(*)::text AS n FROM sales WHERE recording_id = ${RECORDING_ID}
`;
console.log("before ask_events=", beforeEvents[0]?.n, "sales=", beforeSales[0]?.n);

const seg = await segmentAuctionFromSignals(sql, RECORDING_ID);
console.log("segment", seg);
const recap = await reconcileSales(sql, RECORDING_ID, storageRoot);
console.log("reconcile", recap);

const rows = await sql<{
  offset_ms: number | null;
  event_type: string;
  payload: Record<string, unknown>;
  confidence: number | null;
}[]>`
  SELECT offset_ms, event_type, payload, confidence
  FROM auction_events
  WHERE recording_id = ${RECORDING_ID}
    AND event_type IN ('price_mention', 'item_intro', 'pass', 'sold')
  ORDER BY COALESCE(offset_ms, 0) ASC
`;
const timeline: TimelineEvent[] = rows.map((r, i) => {
  const p = r.payload ?? {};
  return {
    id: typeof p.refId === "string" ? p.refId : `e-${i}`,
    offsetMs: Number(r.offset_ms ?? 0),
    eventType: r.event_type as TimelineEvent["eventType"],
    source: p.source === "comment" ? "comment" : "transcript",
    amountTry:
      p.amountTry != null && Number.isFinite(Number(p.amountTry))
        ? Number(p.amountTry)
        : undefined,
    reason: typeof p.reason === "string" ? p.reason : undefined,
    matched: typeof p.matched === "string" ? p.matched : "",
    confidence: Number(r.confidence ?? 0),
    productHint:
      typeof p.productHint === "string" ? p.productHint : undefined,
  };
});
const offer = summarizeOfferWindows(timeline);
const [sales] = await sql<{ n: string; sum: string }[]>`
  SELECT COUNT(*)::text AS n,
    COALESCE(SUM(amount_cents),0)::text AS sum
  FROM sales WHERE recording_id = ${RECORDING_ID}
`;
const [comments] = await sql<{ n: string }[]>`
  SELECT COUNT(*)::text AS n FROM observed_comments WHERE recording_id = ${RECORDING_ID}
`;
const [segs] = await sql<{ n: string }[]>`
  SELECT COUNT(*)::text AS n FROM transcript_segments WHERE recording_id = ${RECORDING_ID}
`;

console.log("--- after ---");
console.log({
  productsOffered: offer.productsOffered,
  totalAskTry: offer.offeredSumTry,
  productsSold: Number(sales?.n ?? 0),
  totalSoldTry: Number(sales?.sum ?? 0) / 100,
  transcriptSegments: Number(segs?.n ?? 0),
  comments: Number(comments?.n ?? 0),
  lots: offer.lots.map((l) => ({
    min: (l.openMs / 60000).toFixed(1),
    ask: l.openingAskTry,
    hint: (l.productHint ?? "").slice(0, 50),
  })),
});

await sql.end?.();
process.exit(0);
