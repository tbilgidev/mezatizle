/**
 * Recording-level report aggregates for Raporlar UI.
 * Stable JSON — LOCAL only, no paid fields.
 *
 * GET /api/reports
 * GET /api/reports/:recordingId  → sales list with thumbnails (not job logs)
 * GET /api/reports/:recordingId/export.csv
 */
import { Hono } from "hono";
import type { Sql } from "@mezatizle/db";
import {
  summarizeOfferWindows,
  type TimelineEvent,
} from "@mezatizle/shared";

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
  /** Sunulan ürün sayısı (ask windows). */
  productsOfferedCount: number;
  /** Alias for UI workers. */
  productsOffered: number;
  /** Satışa sunulan toplam tutar (ask sum TRY). */
  productsOfferedSumTry: number;
  /** Alias for UI workers. */
  totalAskTry: number;
  /** Satılan ürün sayısı (= saleCount with amount; alias for UI). */
  productsSoldCount: number;
  /** Alias for UI workers. */
  productsSold: number;
  /** Toplam satış tutarı (= sumAmountTry). */
  productsSoldSumTry: number;
  /** Alias for UI workers. */
  totalSoldTry: number;
  /** Offered but not sold (offer windows − sold). */
  productsUnsoldCount: number;
  /** Sales by method when known. */
  salesByMethod: {
    aldimFirstComment: number;
    bidWinConfirm: number;
    counterAccept: number;
    other: number;
  };
};

export type ReportSaleRow = {
  id: string;
  productId: string | null;
  productTitle: string | null;
  productDescription: string | null;
  /** Absolute API path for UI: /api/products/:id/image */
  thumbnailUrl: string | null;
  buyerUsername: string | null;
  /** Spoken name when different from @handle; never invented as username. */
  spokenBuyerName: string | null;
  amountCents: number | null;
  amountTry: number | null;
  currency: string;
  saleMethod: string | null;
  /** Alias of saleMethod for mezatizle-ui ReportDetailPage. */
  detectionMethod: string | null;
  soldAt: string | null;
  offsetMs: number | null;
  confidence: number | null;
  status: string;
  evidenceIds: string[];
  explanationTr: string | null;
};

export type ReportDetail = ReportListItem & {
  sales: ReportSaleRow[];
  eventCounts: Record<string, number>;
  transcriptSegmentCount: number;
  commentCount: number;
  /** Job summary kept for debug; UI should prefer `sales`. */
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
  const offered = `${r.productsOfferedCount} sunulan`;
  const sold =
    r.productsSoldCount === 0
      ? "0 satılan"
      : `${r.productsSoldCount} satılan`;
  const soldSum =
    r.productsSoldSumTry != null && r.productsSoldSumTry > 0
      ? ` · satış ≈${Math.round(r.productsSoldSumTry).toLocaleString("tr-TR")} TRY`
      : "";
  const offerSum =
    r.productsOfferedSumTry != null && r.productsOfferedSumTry > 0
      ? ` · sunulan ≈${Math.round(r.productsOfferedSumTry).toLocaleString("tr-TR")} TRY`
      : "";
  const dur =
    r.durationSeconds != null && r.durationSeconds > 0
      ? ` · ${formatDurationShort(r.durationSeconds)}`
      : "";
  return `${seller} — ${offered} · ${sold}${soldSum}${offerSum}${dur}`;
}

/**
 * Offer KPIs from sparse product lots (packages/shared buildProductLots).
 * productsOffered = distinct lots; totalAskTry = sum of opening asks only.
 */
async function loadOfferKpis(
  sql: Sql,
  recordingId: string,
): Promise<{ productsOfferedCount: number; productsOfferedSumTry: number }> {
  const rows = await sql<{
    offset_ms: number | null;
    event_type: string;
    payload: Record<string, unknown>;
    confidence: number | null;
  }[]>`
    SELECT offset_ms, event_type, payload, confidence
    FROM auction_events
    WHERE recording_id = ${recordingId}
      AND event_type IN ('price_mention', 'item_intro', 'pass', 'sold')
    ORDER BY COALESCE(offset_ms, 0) ASC
  `;
  const timeline: TimelineEvent[] = rows.map((r, i) => {
    const p = r.payload ?? {};
    return {
      id: typeof p.refId === "string" ? p.refId : `kpi-${i}`,
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
  const s = summarizeOfferWindows(timeline);
  return {
    productsOfferedCount: s.productsOffered,
    productsOfferedSumTry: s.offeredSumTry,
  };
}

async function loadSalesByMethod(
  sql: Sql,
  recordingId: string,
): Promise<ReportListItem["salesByMethod"]> {
  const rows = await sql<{ method: string | null; n: string }[]>`
    SELECT p.attributes->>'saleMethod' AS method, COUNT(*)::text AS n
    FROM sales sa
    LEFT JOIN products p ON p.id = sa.product_id
    WHERE sa.recording_id = ${recordingId}
    GROUP BY 1
  `;
  const out = {
    aldimFirstComment: 0,
    bidWinConfirm: 0,
    counterAccept: 0,
    other: 0,
  };
  for (const r of rows) {
    const n = Number(r.n);
    const m = r.method ?? "";
    if (m === "aldim_first_comment") out.aldimFirstComment += n;
    else if (m === "bid_win_confirm") out.bidWinConfirm += n;
    else if (m === "counter_accept") out.counterAccept += n;
    else out.other += n;
  }
  return out;
}

function toIso(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  const s = String(v);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toISOString();
}

function rowToListItem(
  r: Record<string, unknown>,
  kpis?: {
    productsOfferedCount: number;
    productsOfferedSumTry: number;
    salesByMethod: ReportListItem["salesByMethod"];
  },
): ReportListItem {
  const saleCount = Number(r.sale_count ?? 0);
  const sumCents = r.sum_amount_cents != null ? Number(r.sum_amount_cents) : null;
  const avgConf =
    r.avg_event_confidence != null &&
    Number.isFinite(Number(r.avg_event_confidence))
      ? Number(r.avg_event_confidence)
      : null;
  const offered = kpis?.productsOfferedCount ?? 0;
  const offeredSum = Number(kpis?.productsOfferedSumTry ?? 0);
  const soldSum =
    sumCents != null && Number.isFinite(sumCents) ? sumCents / 100 : 0;
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
    sumAmountTry: soldSum,
    currency: "TRY",
    sourceType: r.source_type != null ? String(r.source_type) : null,
    avgEventConfidence: avgConf,
    headline: "",
    productsOfferedCount: offered,
    productsOffered: offered,
    productsOfferedSumTry: offeredSum,
    totalAskTry: offeredSum,
    productsSoldCount: saleCount,
    productsSold: saleCount,
    productsSoldSumTry: soldSum,
    totalSoldTry: soldSum,
    productsUnsoldCount: Math.max(0, offered - saleCount),
    salesByMethod: kpis?.salesByMethod ?? {
      aldimFirstComment: 0,
      bidWinConfirm: 0,
      counterAccept: 0,
      other: 0,
    },
  };
  item.headline = buildHeadline(item);
  return item;
}

function csvEscape(v: string) {
  if (/[",\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

function attrString(
  attrs: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  if (!attrs || typeof attrs !== "object") return null;
  const v = attrs[key];
  if (v == null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

function attrNumber(
  attrs: Record<string, unknown> | null | undefined,
  key: string,
): number | null {
  if (!attrs || typeof attrs !== "object") return null;
  const v = attrs[key];
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
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
    const reports: ReportListItem[] = [];
    for (const row of rows) {
      const id = String(row.recording_id);
      const [offer, methods] = await Promise.all([
        loadOfferKpis(sql, id),
        loadSalesByMethod(sql, id),
      ]);
      reports.push(
        rowToListItem(row, {
          productsOfferedCount: offer.productsOfferedCount,
          productsOfferedSumTry: offer.productsOfferedSumTry,
          salesByMethod: methods,
        }),
      );
    }
    return c.json({
      reports,
      totals: {
        recordings: reports.length,
        sales: reports.reduce((a, x) => a + x.saleCount, 0),
        needsReview: reports.reduce((a, x) => a + x.needsReviewCount, 0),
        sumAmountTry: reports.reduce((a, x) => a + (x.sumAmountTry ?? 0), 0),
        productsOfferedCount: reports.reduce(
          (a, x) => a + x.productsOfferedCount,
          0,
        ),
        productsOfferedSumTry: reports.reduce(
          (a, x) => a + (x.productsOfferedSumTry ?? 0),
          0,
        ),
        productsSoldCount: reports.reduce((a, x) => a + x.productsSoldCount, 0),
        productsSoldSumTry: reports.reduce(
          (a, x) => a + (x.productsSoldSumTry ?? 0),
          0,
        ),
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

    const [offer, methods] = await Promise.all([
      loadOfferKpis(sql, recordingId),
      loadSalesByMethod(sql, recordingId),
    ]);
    const base = rowToListItem(rows[0], {
      productsOfferedCount: offer.productsOfferedCount,
      productsOfferedSumTry: offer.productsOfferedSumTry,
      salesByMethod: methods,
    });

    const sales = await sql<Record<string, unknown>[]>`
      SELECT
        sa.id,
        sa.product_id,
        sa.buyer_username,
        sa.amount_cents,
        sa.currency,
        sa.status,
        sa.sold_at,
        p.title AS product_title,
        p.description AS product_description,
        p.attributes AS product_attributes
      FROM sales sa
      LEFT JOIN products p ON p.id = sa.product_id
      WHERE sa.recording_id = ${recordingId}
      ORDER BY sa.sold_at ASC NULLS LAST, sa.created_at ASC
    `;

    const saleIds = sales.map((s) => String(s.id));
    const evidenceBySale = new Map<
      string,
      Array<{ id: string; payload: Record<string, unknown> }>
    >();
    if (saleIds.length) {
      const evRows = await sql<
        {
          id: string;
          sale_id: string;
          payload: Record<string, unknown>;
          evidence_type: string;
        }[]
      >`
        SELECT id, sale_id, payload, evidence_type
        FROM sale_evidence
        WHERE sale_id = ANY(${saleIds}::uuid[])
        ORDER BY created_at ASC
      `;
      for (const e of evRows) {
        const list = evidenceBySale.get(String(e.sale_id)) ?? [];
        list.push({
          id: String(e.id),
          payload: (e.payload ?? {}) as Record<string, unknown>,
        });
        evidenceBySale.set(String(e.sale_id), list);
      }
    }

    const saleRows: ReportSaleRow[] = sales.map((s) => {
      const productId = s.product_id != null ? String(s.product_id) : null;
      const attrs =
        s.product_attributes && typeof s.product_attributes === "object"
          ? (s.product_attributes as Record<string, unknown>)
          : null;
      const imagePath = attrString(attrs, "imagePath");
      const evList = evidenceBySale.get(String(s.id)) ?? [];
      const primaryEv = evList[0];
      const evPayload = primaryEv?.payload ?? {};

      const confidence =
        attrNumber(attrs, "confidence") ??
        (evPayload.confidence != null
          ? Number(evPayload.confidence)
          : null);
      const offsetMs =
        attrNumber(attrs, "offsetMs") ??
        (evPayload.offsetMs != null ? Number(evPayload.offsetMs) : null);
      const saleMethod =
        attrString(attrs, "saleMethod") ??
        (typeof evPayload.saleMethod === "string"
          ? evPayload.saleMethod
          : null);
      const spokenBuyerName =
        attrString(attrs, "spokenBuyerName") ??
        (typeof evPayload.spokenBuyerName === "string"
          ? evPayload.spokenBuyerName
          : null);
      const explanationTr =
        typeof evPayload.explanationTr === "string"
          ? evPayload.explanationTr
          : null;

      return {
        id: String(s.id),
        productId,
        productTitle:
          s.product_title != null ? String(s.product_title) : null,
        productDescription:
          s.product_description != null
            ? String(s.product_description)
            : null,
        thumbnailUrl:
          productId && imagePath
            ? `/api/products/${productId}/image`
            : null,
        buyerUsername:
          s.buyer_username != null ? String(s.buyer_username) : null,
        spokenBuyerName,
        amountCents: s.amount_cents != null ? Number(s.amount_cents) : null,
        amountTry:
          s.amount_cents != null ? Number(s.amount_cents) / 100 : null,
        currency: String(s.currency ?? "TRY"),
        saleMethod,
        detectionMethod: saleMethod,
        soldAt: toIso(s.sold_at),
        offsetMs,
        confidence:
          confidence != null && Number.isFinite(confidence)
            ? confidence
            : null,
        status: String(s.status),
        evidenceIds: evList.map((e) => e.id),
        explanationTr,
      };
    });

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
      sales: saleRows,
      eventCounts,
      transcriptSegmentCount: Number(tr?.n ?? 0),
      commentCount: Number(cm?.n ?? 0),
      jobs: jobs.map((j) => ({
        jobType: String(j.job_type),
        status: String(j.status),
        progressPercent: Number(j.progress_percent ?? 0),
        stage: j.stage != null ? String(j.stage) : null,
        finishedAt: toIso(j.finished_at),
      })),
    };

    return c.json({ report: detail });
  });

  return app;
}
