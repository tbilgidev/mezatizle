/**
 * Offline slice hillclimb for antikaadunyam — first N minutes only.
 * Does not write DB; prints offers/sales from current shared rules.
 */
import { createSql } from "@mezatizle/db";
import {
  parseAuctionTexts,
  reconcileMezatWindows,
  summarizeOfferWindows,
  type TimelineEvent,
} from "@mezatizle/shared";

const RID = process.env.RECORDING_ID ?? "52cd681e-7967-42ae-b843-449f7c063cdf";
const SLICE_MS = Number(process.env.SLICE_MS ?? 600_000);
const INCLUDE_OCR = process.env.INCLUDE_OCR === "1";

const sql = createSql(
  process.env.DATABASE_URL ??
    "postgres://mezatizle:mezatizle@127.0.0.1:5433/mezatizle",
);

const [rec] = await sql<
  { capture_started_at: Date | string | null; duration_seconds: number | null }[]
>`
  SELECT capture_started_at, duration_seconds FROM recordings WHERE id = ${RID}`;
const captureStartedMs = rec?.capture_started_at
  ? new Date(rec.capture_started_at).getTime()
  : null;

const segments = await sql<{ id: string; start_ms: number; text: string }[]>`
  SELECT id, start_ms, text FROM transcript_segments
  WHERE recording_id = ${RID} AND start_ms < ${SLICE_MS}
  ORDER BY start_ms`;
const comments = await sql<
  {
    id: string;
    offset_ms: number | null;
    body: string;
    author_username: string | null;
    source: string;
    observed_at: Date | string | null;
  }[]
>`
  SELECT id, offset_ms, body, author_username, source, observed_at
  FROM observed_comments
  WHERE recording_id = ${RID}
    AND COALESCE(offset_ms, 0) < ${SLICE_MS}
  ORDER BY COALESCE(offset_ms, 0)`;

const timeline: TimelineEvent[] = [];
let n = 0;
for (const seg of segments) {
  for (const signal of parseAuctionTexts(seg.text, { source: "transcript" })) {
    timeline.push({
      id: `t${++n}`,
      offsetMs: seg.start_ms,
      eventType: signal.eventType,
      source: "transcript",
      amountTry: signal.amountTry,
      buyerHint: signal.buyerHint,
      reason: signal.reason,
      matched: signal.matched,
      confidence: signal.confidence,
      productHint: signal.productHint,
    });
  }
}
for (const c of comments) {
  if (!INCLUDE_OCR && c.source === "ocr_tesseract") continue;
  if (
    captureStartedMs != null &&
    c.observed_at != null &&
    new Date(c.observed_at).getTime() < captureStartedMs - 2_000
  ) {
    continue;
  }
  for (let signal of parseAuctionTexts(c.body, { source: "comment" })) {
    const author = c.author_username?.toLowerCase();
    if (author && !signal.buyerHint && signal.eventType === "bid") {
      signal = { ...signal, buyerHint: author };
    }
    timeline.push({
      id: `c${++n}`,
      offsetMs: c.offset_ms ?? 0,
      eventType: signal.eventType,
      source: "comment",
      amountTry: signal.amountTry,
      buyerHint: signal.buyerHint,
      reason: signal.reason,
      matched: signal.matched,
      confidence: signal.confidence,
      productHint: signal.productHint,
    });
  }
}

const offers = summarizeOfferWindows(timeline);
const sales = reconcileMezatWindows(timeline);
const byType: Record<string, number> = {};
for (const e of timeline) byType[e.eventType] = (byType[e.eventType] ?? 0) + 1;

const asks = timeline
  .filter(
    (e) => e.eventType === "price_mention" || e.eventType === "item_intro",
  )
  .map((e) => ({
    sec: Math.round(e.offsetMs / 1000),
    reason: e.reason,
    amt: e.amountTry,
    src: e.source,
    matched: e.matched.slice(0, 70),
  }));

const bids = timeline
  .filter((e) => e.eventType === "bid")
  .map((e) => ({
    sec: Math.round(e.offsetMs / 1000),
    reason: e.reason,
    amt: e.amountTry,
    buyer: e.buyerHint,
    matched: e.matched.slice(0, 50),
  }));

console.log(
  JSON.stringify(
    {
      recordingId: RID,
      sliceSec: SLICE_MS / 1000,
      eventCounts: byType,
      offers,
      salesCount: sales.length,
      sales: sales.map((s) => ({
        sec: Math.round(s.offsetMs / 1000),
        buyer: s.buyerUsername,
        amountTry: s.amountTry,
        method: s.saleMethod,
        reason: s.reason,
        product: s.productHint?.slice(0, 80),
      })),
      asks,
      bids,
    },
    null,
    2,
  ),
);

await sql.end();
