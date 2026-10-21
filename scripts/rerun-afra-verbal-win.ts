/**
 * Re-segment + reconcile afra (or any recording) after verbal-win confirm logic.
 * Keeps transcript + comments. Does not wipe ASR / live_api comments.
 *
 * Usage: bun run ./scripts/rerun-afra-verbal-win.ts [recording-id]
 */
import { createSql } from "@mezatizle/db";
import { summarizeOfferWindows, type TimelineEvent } from "@mezatizle/shared";
import {
  reconcileSales,
  segmentAuctionFromSignals,
} from "../apps/api/src/modules/auction_pipeline.ts";

const RECORDING_ID =
  process.argv[2] ?? "69765459-23ff-4e0c-a8ce-aaa992b2c281";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://mezatizle:mezatizle@127.0.0.1:5433/mezatizle";
const storageRoot = process.env.STORAGE_ROOT ?? "./storage";

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
  { buyer_username: string | null; amount_cents: string | null }[]
>`
  SELECT buyer_username, amount_cents::text AS amount_cents
  FROM sales WHERE recording_id = ${RECORDING_ID}
  ORDER BY sold_at ASC NULLS LAST, created_at ASC
`;
const [beforeCounts] = await sql<
  { comments: string; transcript: string; events: string; sales: string }[]
>`
  SELECT
    (SELECT COUNT(*)::text FROM observed_comments WHERE recording_id = ${RECORDING_ID}) AS comments,
    (SELECT COUNT(*)::text FROM transcript_segments WHERE recording_id = ${RECORDING_ID}) AS transcript,
    (SELECT COUNT(*)::text FROM auction_events WHERE recording_id = ${RECORDING_ID}) AS events,
    (SELECT COUNT(*)::text FROM sales WHERE recording_id = ${RECORDING_ID}) AS sales
`;
console.log("before", beforeCounts);
console.log(
  "before sales detail",
  beforeSales.map((s) => ({
    buyer: s.buyer_username,
    try: s.amount_cents != null ? Number(s.amount_cents) / 100 : null,
  })),
);

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
    spokenBuyerName:
      typeof p.spokenBuyerName === "string" ? p.spokenBuyerName : undefined,
    confidence: Number(r.confidence ?? 0),
    productHint:
      typeof p.productHint === "string" ? p.productHint : undefined,
  };
});
const offer = summarizeOfferWindows(timeline);
const afterSales = await sql<
  {
    buyer_username: string | null;
    amount_cents: string | null;
    status: string;
  }[]
>`
  SELECT buyer_username, amount_cents::text AS amount_cents, status
  FROM sales WHERE recording_id = ${RECORDING_ID}
  ORDER BY sold_at ASC NULLS LAST, created_at ASC
`;
const confirmedSales = afterSales.filter((s) => s.status === "confirmed");
const reviewSales = afterSales.filter((s) => s.status === "needs_review");
const verbalSold = rows.filter((r) => {
  const p = r.payload ?? {};
  return (
    r.event_type === "sold" &&
    typeof p.reason === "string" &&
    p.reason.includes("verbal_win")
  );
});
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
  productsSold: confirmedSales.length,
  totalSoldTry: confirmedSales.reduce(
    (a, s) => a + (s.amount_cents != null ? Number(s.amount_cents) / 100 : 0),
    0,
  ),
  needsReview: reviewSales.length,
  transcriptSegments: Number(segs?.n ?? 0),
  comments: Number(comments?.n ?? 0),
  verbalWinSoldEvents: verbalSold.length,
  sampleVerbal: verbalSold.slice(0, 12).map((r) => ({
    ms: r.offset_ms,
    matched: String((r.payload ?? {}).matched ?? "").slice(0, 80),
    spoken: (r.payload ?? {}).spokenBuyerName,
    reason: (r.payload ?? {}).reason,
  })),
  sales: afterSales.map((s) => ({
    buyer: s.buyer_username,
    try: s.amount_cents != null ? Number(s.amount_cents) / 100 : null,
    status: s.status,
  })),
});

await sql.end?.();
process.exit(0);
