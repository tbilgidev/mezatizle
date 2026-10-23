/**
 * Clear sales/products/events for a recording and re-run segment→reconcile.
 * Keeps video, transcript, and comments.
 *
 * Usage: bun run ./scripts/rerun-nunus-reconcile.ts [recording-id]
 */
import { createSql } from "@mezatizle/db";
import { summarizeOfferWindows, type TimelineEvent } from "@mezatizle/shared";
import {
  reconcileSales,
  segmentAuctionFromSignals,
} from "../apps/api/src/modules/auction_pipeline.ts";

const RECORDING_ID =
  process.argv[2] ?? "42577ec1-c50c-45fa-9691-362b417d7312";

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

// Clear prior sales/report rows (keep video/transcript/comments).
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
console.log("cleared sales/products/events/jobs for", RECORDING_ID);

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
    reason: typeof p.reason === "string" ? p.reason : undefined,
    matched: typeof p.matched === "string" ? p.matched : "",
    confidence: Number(r.confidence ?? p.confidence ?? 0),
    productHint:
      typeof p.productHint === "string" ? p.productHint : undefined,
    lotNumber:
      p.lotNumber != null && Number.isFinite(Number(p.lotNumber))
        ? Number(p.lotNumber)
        : undefined,
    descriptorTokens: Array.isArray(p.descriptorTokens)
      ? (p.descriptorTokens as string[]).filter((t) => typeof t === "string")
      : undefined,
  };
});
const offers = summarizeOfferWindows(timeline);

const saleRows = await sql<
  {
    status: string;
    buyer_username: string | null;
    amount_cents: string | null;
    title: string | null;
    attrs: Record<string, unknown> | null;
  }[]
>`
  SELECT s.status, s.buyer_username, s.amount_cents::text AS amount_cents,
         p.title, p.attributes AS attrs
  FROM sales s
  LEFT JOIN products p ON p.id = s.product_id
  WHERE s.recording_id = ${RECORDING_ID}
  ORDER BY s.sold_at ASC NULLS LAST, s.created_at ASC
`;

const confirmed = saleRows.filter((s) => s.status === "confirmed");
const review = saleRows.filter((s) => s.status === "needs_review");
const sumTry = confirmed.reduce(
  (a, s) => a + (s.amount_cents != null ? Number(s.amount_cents) / 100 : 0),
  0,
);
const reviewPriced = review.filter((s) => s.amount_cents != null).length;
const numbered = confirmed.filter(
  (s) =>
    String(s.attrs?.saleMethod ?? "").includes("verbal") ||
    String(s.title ?? "").includes("numara") ||
    String(s.attrs?.evidenceQuote ?? "").includes("numara") ||
    String((s.attrs as { reason?: string } | null)?.reason ?? "").includes(
      "numbered",
    ),
);

console.log(
  JSON.stringify(
    {
      productsOffered: offers.productsOffered,
      offeredSumTry: offers.offeredSumTry,
      soldConfirmed: confirmed.length,
      soldSumTry: sumTry,
      needsReview: review.length,
      needsReviewPriced: reviewPriced,
      sampleConfirmed: confirmed.slice(0, 12).map((s) => ({
        buyer: s.buyer_username,
        try: s.amount_cents != null ? Number(s.amount_cents) / 100 : null,
        title: (s.title ?? "").slice(0, 60),
        method: s.attrs?.saleMethod,
        quote: String(s.attrs?.evidenceQuote ?? "").slice(0, 80),
      })),
      sampleReview: review.slice(0, 8).map((s) => ({
        buyer: s.buyer_username,
        try: s.amount_cents != null ? Number(s.amount_cents) / 100 : null,
        ask: s.attrs?.askAmountTry,
        title: (s.title ?? "").slice(0, 60),
      })),
      numberedSample: numbered.slice(0, 8),
    },
    null,
    2,
  ),
);

await sql.end();
