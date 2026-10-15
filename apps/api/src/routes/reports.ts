/**
 * Recording-level report aggregates for Raporlar UI.
 * Stable JSON — LOCAL only, no paid fields.
 *
 * GET /api/reports
 * GET /api/reports/:recordingId
 * GET /api/reports/:recordingId/export.csv
 */
import { Hono } from "hono";
import type { Sql } from "@mezatizle/db";

export type ReportListItem = {
  recordingId: string;
  sellerUsername: string;
  displayName: string | null;
  originalFilename: string;
  status: string;
  recordedAt: string | null;
  uploadedAt: string | null;
  durationSeconds: number | null;
  saleCount: number;
  needsReviewCount: number;
  confirmedCount: number;
  rejectedCount: number;
  sumAmountTry: number | null;
  currency: string;
  sourceType: string | null;
  avgEventConfidence: number | null;
  headline: string;
};

export type ReportDetail = ReportListItem & {
  sales: Array<{
    id: string;
    buyerUsername: string | null;
    amountCents: number | null;
    amountTry: number | null;
    status: string;
    productTitle: string | null;
    soldAt: string | null;
  }>;
  eventCounts: Record<string, number>;
  transcriptSegmentCount: number;
  commentCount: number;
  jobs: Array<{
    jobType: string;
    status: string;
    progressPercent: number;
    stage: string | null;
    finishedAt: string | null;
  }>;
};

function formatDurationShort(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}s ${m}dk`;
  if (m > 0) return `${m} dk`;
  return `${s} sn`;
}

function buildHeadline(r: ReportListItem): string {
  const seller = r.sellerUsername ? `@${r.sellerUsername}` : "Satıcı";
  const sales =
    r.saleCount === 0
      ? "satış tespit edilmedi"
      : `${r.saleCount} satış adayı`;
  const total =
    r.sumAmountTry != null && r.sumAmountTry > 0
      ? ` · ≈${Math.round(r.sumAmountTry).toLocaleString("tr-TR")} TRY`
      : "";
  const dur =
    r.durationSeconds != null && r.durationSeconds > 0
      ? ` · ${formatDurationShort(r.durationSeconds)}`
      : "";
  return `${seller} — ${sales}${total}${dur}`;
}

function toIso(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  const s = String(v);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toISOString();
}

function rowToListItem(r: Record<string, unknown>): ReportListItem {
  const saleCount = Number(r.sale_count ?? 0);
  const sumCents = r.sum_amount_cents != null ? Number(r.sum_amount_cents) : null;
  const avgConf =
    r.avg_event_confidence != null &&
    Number.isFinite(Number(r.avg_event_confidence))
      ? Number(r.avg_event_confidence)
      : null;
  const item: ReportListItem = {
    recordingId: String(r.recording_id),
    sellerUsername: String(r.instagram_username ?? ""),
    displayName:
      r.display_name != null && String(r.display_name).length
        ? String(r.display_name)
        : null,
    originalFilename: String(r.original_filename ?? ""),
    status: String(r.status ?? ""),
    recordedAt: toIso(r.recorded_at),
    uploadedAt: toIso(r.uploaded_at),
    durationSeconds:
      r.duration_seconds != null && Number.isFinite(Number(r.duration_seconds))
        ? Number(r.duration_seconds)
        : null,
    saleCount,
    needsReviewCount: Number(r.needs_review_count ?? 0),
    confirmedCount: Number(r.confirmed_count ?? 0),
    rejectedCount: Number(r.rejected_count ?? 0),
    sumAmountTry:
      sumCents != null && Number.isFinite(sumCents) ? sumCents / 100 : null,
    currency: "TRY",
    sourceType: r.source_type != null ? String(r.source_type) : null,
    avgEventConfidence: avgConf,
    headline: "",
  };
  item.headline = buildHeadline(item);
  return item;
}

function csvEscape(v: string) {
  if (/[",\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

export function reportsRoutes(sql: Sql) {
  const app = new Hono();

  app.get("/", async (c) => {
    const rows = await sql<Record<string, unknown>[]>`
      SELECT
        r.id AS recording_id,
        r.original_filename,
        r.status,
        r.recorded_at,
        r.uploaded_at,
        r.duration_seconds,
        r.source_type,
        s.instagram_username,
        s.display_name,
        COUNT(sa.id)::int AS sale_count,
        COUNT(sa.id) FILTER (WHERE sa.status = 'needs_review')::int AS needs_review_count,
        COUNT(sa.id) FILTER (WHERE sa.status = 'confirmed')::int AS confirmed_count,
        COUNT(sa.id) FILTER (WHERE sa.status = 'rejected')::int AS rejected_count,
        SUM(sa.amount_cents) FILTER (
          WHERE sa.amount_cents IS NOT NULL AND sa.status <> 'rejected'
        ) AS sum_amount_cents,
        (
          SELECT AVG(ae.confidence)
          FROM auction_events ae
          WHERE ae.recording_id = r.id AND ae.confidence IS NOT NULL
        ) AS avg_event_confidence
      FROM recordings r
      JOIN sellers s ON s.id = r.seller_id
      LEFT JOIN sales sa ON sa.recording_id = r.id
      GROUP BY r.id, s.instagram_username, s.display_name
      ORDER BY r.recorded_at DESC NULLS LAST, r.created_at DESC
      LIMIT 500
    `;
    const reports = rows.map(rowToListItem);
    return c.json({
      reports,
      totals: {
        recordings: reports.length,
        sales: reports.reduce((a, x) => a + x.saleCount, 0),
        needsReview: reports.reduce((a, x) => a + x.needsReviewCount, 0),
        sumAmountTry: reports.reduce((a, x) => a + (x.sumAmountTry ?? 0), 0),
        currency: "TRY",
      },
    });
  });

  app.get("/:recordingId/export.csv", async (c) => {
    const recordingId = c.req.param("recordingId");
    const rows = await sql`
      SELECT sa.id, s.instagram_username, p.title, sa.buyer_username,
             sa.amount_cents, sa.currency, sa.status, sa.sold_at, sa.recording_id
      FROM sales sa
      JOIN sellers s ON s.id = sa.seller_id
      LEFT JOIN products p ON p.id = sa.product_id
      WHERE sa.recording_id = ${recordingId}
      ORDER BY sa.created_at DESC
    `;
    const header =
      "id,instagram_username,title,buyer_username,amount_cents,currency,status,sold_at,recording_id";
    const lines = rows.map((r) =>
      [
        r.id,
        r.instagram_username,
        csvEscape(String(r.title ?? "")),
        r.buyer_username ?? "",
        r.amount_cents ?? "",
        r.currency,
        r.status,
        r.sold_at ?? "",
        r.recording_id ?? "",
      ].join(","),
    );
    return new Response([header, ...lines].join("\n"), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename=mezatizle-report-${recordingId.slice(0, 8)}.csv`,
      },
    });
  });

  app.get("/:recordingId", async (c) => {
    const recordingId = c.req.param("recordingId");
    const rows = await sql<Record<string, unknown>[]>`
      SELECT
        r.id AS recording_id,
        r.original_filename,
        r.status,
        r.recorded_at,
        r.uploaded_at,
        r.duration_seconds,
        r.source_type,
        s.instagram_username,
        s.display_name,
        COUNT(sa.id)::int AS sale_count,
        COUNT(sa.id) FILTER (WHERE sa.status = 'needs_review')::int AS needs_review_count,
        COUNT(sa.id) FILTER (WHERE sa.status = 'confirmed')::int AS confirmed_count,
        COUNT(sa.id) FILTER (WHERE sa.status = 'rejected')::int AS rejected_count,
        SUM(sa.amount_cents) FILTER (
          WHERE sa.amount_cents IS NOT NULL AND sa.status <> 'rejected'
        ) AS sum_amount_cents,
        (
          SELECT AVG(ae.confidence)
          FROM auction_events ae
          WHERE ae.recording_id = r.id AND ae.confidence IS NOT NULL
        ) AS avg_event_confidence
      FROM recordings r
      JOIN sellers s ON s.id = r.seller_id
      LEFT JOIN sales sa ON sa.recording_id = r.id
      WHERE r.id = ${recordingId}
      GROUP BY r.id, s.instagram_username, s.display_name
    `;
    if (!rows[0]) return c.json({ error: "Kayıt bulunamadı" }, 404);

    const base = rowToListItem(rows[0]);

    const sales = await sql<Record<string, unknown>[]>`
      SELECT sa.id, sa.buyer_username, sa.amount_cents, sa.status, sa.sold_at,
             p.title AS product_title
      FROM sales sa
      LEFT JOIN products p ON p.id = sa.product_id
      WHERE sa.recording_id = ${recordingId}
      ORDER BY sa.sold_at ASC NULLS LAST, sa.created_at ASC
    `;

    const eventRows = await sql<{ event_type: string; n: string }[]>`
      SELECT event_type, COUNT(*)::text AS n
      FROM auction_events
      WHERE recording_id = ${recordingId}
      GROUP BY event_type
    `;
    const eventCounts: Record<string, number> = {};
    for (const e of eventRows) eventCounts[e.event_type] = Number(e.n);

    const [tr] = await sql<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM transcript_segments
      WHERE recording_id = ${recordingId}
    `;
    const [cm] = await sql<{ n: string }[]>`
      SELECT COUNT(*)::text AS n FROM observed_comments
      WHERE recording_id = ${recordingId}
    `;

    const jobs = await sql<Record<string, unknown>[]>`
      SELECT job_type, status, progress_percent, stage, finished_at
      FROM processing_jobs
      WHERE recording_id = ${recordingId}
      ORDER BY created_at ASC
    `;

    const detail: ReportDetail = {
      ...base,
      sales: sales.map((s) => ({
        id: String(s.id),
        buyerUsername: s.buyer_username != null ? String(s.buyer_username) : null,
        amountCents: s.amount_cents != null ? Number(s.amount_cents) : null,
        amountTry:
          s.amount_cents != null ? Number(s.amount_cents) / 100 : null,
        status: String(s.status),
        productTitle: s.product_title != null ? String(s.product_title) : null,
        soldAt: s.sold_at != null ? String(s.sold_at) : null,
      })),
      eventCounts,
      transcriptSegmentCount: Number(tr?.n ?? 0),
      commentCount: Number(cm?.n ?? 0),
      jobs: jobs.map((j) => ({
        jobType: String(j.job_type),
        status: String(j.status),
        progressPercent: Number(j.progress_percent ?? 0),
        stage: j.stage != null ? String(j.stage) : null,
        finishedAt: j.finished_at != null ? String(j.finished_at) : null,
      })),
    };

    return c.json({ report: detail });
  });

  return app;
}
