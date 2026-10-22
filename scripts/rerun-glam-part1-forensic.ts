/**
 * Wipe glam part1 sales/events only; keep comments + transcript + video.
 * Re-segment from existing ASR/comments, then reconcile with ask-freeze fixes.
 *
 * Usage: bun run ./scripts/rerun-glam-part1-forensic.ts [recording-id]
 */
import { createSql } from "@mezatizle/db";
import { summarizeOfferWindows, type TimelineEvent } from "@mezatizle/shared";
import {
  reconcileSales,
  segmentAuctionFromSignals,
} from "../apps/api/src/modules/auction_pipeline.ts";

const RECORDING_ID =
  process.argv[2] ?? "8e6f1087-d1e8-4cb0-b668-3290a4e88d81";

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
  "before sales",
  beforeSales.map((s) => ({
    buyer: s.buyer_username,
    try: s.amount_cents != null ? Number(s.amount_cents) / 100 : null,
    status: s.status,
  })),
);

// Keep comments + transcript; wipe sales (reconcileSales does this) + events via segment.
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
    sold_at: Date | string | null;
    attrs: Record<string, unknown> | null;
  }[]
>`
  SELECT
    sa.buyer_username,
    sa.amount_cents::text AS amount_cents,
    sa.status,
    sa.sold_at,
    p.attributes AS attrs
  FROM sales sa
  LEFT JOIN products p ON p.id = sa.product_id
  WHERE sa.recording_id = ${RECORDING_ID}
  ORDER BY sa.sold_at ASC NULLS LAST, sa.created_at ASC
`;

const [afterCounts] = await sql<
  { comments: string; transcript: string; events: string; sales: string }[]
>`
  SELECT
    (SELECT COUNT(*)::text FROM observed_comments WHERE recording_id = ${RECORDING_ID}) AS comments,
    (SELECT COUNT(*)::text FROM transcript_segments WHERE recording_id = ${RECORDING_ID}) AS transcript,
    (SELECT COUNT(*)::text FROM auction_events WHERE recording_id = ${RECORDING_ID}) AS events,
    (SELECT COUNT(*)::text FROM sales WHERE recording_id = ${RECORDING_ID}) AS sales
`;

console.log("after", afterCounts);
console.log("offer KPIs", offer);
console.log(
  "after sales",
  afterSales.map((s) => {
    const attrs = s.attrs && typeof s.attrs === "object" ? s.attrs : {};
    return {
      buyer: s.buyer_username,
      try: s.amount_cents != null ? Number(s.amount_cents) / 100 : null,
      ask: attrs.askAmountTry ?? null,
      status: s.status,
      method: attrs.saleMethod ?? null,
      offsetMs: attrs.offsetMs ?? null,
      quote: attrs.evidenceQuote ?? null,
      sold_at: s.sold_at,
    };
  }),
);

await sql.end?.();
process.exit(0);
