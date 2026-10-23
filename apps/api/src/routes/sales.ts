import { Hono } from "hono";
import type { Sql } from "@mezatizle/db";

const SALE_STATUSES = ["needs_review", "confirmed", "rejected", "candidate"] as const;
type SaleStatus = (typeof SALE_STATUSES)[number];

const SALE_METHODS = [
  "aldim_first_comment",
  "bid_win_confirm",
  "verbal_win_confirm",
  "counter_accept",
  "sold_phrase",
  "manual",
] as const;

type ReviewBody = {
  status?: string;
  buyerUsername?: string | null;
  buyer_username?: string | null;
  amountTry?: number | string | null;
  amount_try?: number | string | null;
  soldAmount?: number | string | null;
  sold_amount?: number | string | null;
  askAmount?: number | string | null;
  ask_amount?: number | string | null;
  askAmountTry?: number | string | null;
  ask_amount_try?: number | string | null;
  method?: string | null;
  saleMethod?: string | null;
  sale_method?: string | null;
  detectionMethod?: string | null;
  detection_method?: string | null;
  spokenBuyerName?: string | null;
  spoken_buyer_name?: string | null;
};

export function salesRoutes(sql: Sql) {
  const app = new Hono();

  app.get("/export.csv", async (c) => {
    const rows = await sql`
      SELECT sa.id, s.instagram_username, p.title, sa.buyer_username,
             sa.amount_cents, sa.currency, sa.status, sa.sold_at, sa.recording_id
      FROM sales sa
      JOIN sellers s ON s.id = sa.seller_id
      LEFT JOIN products p ON p.id = sa.product_id
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
        "Content-Disposition": "attachment; filename=mezatizle-sales.csv",
      },
    });
  });

  app.get("/", async (c) => {
    const rows = await sql`
      SELECT sa.*, p.title AS product_title, s.instagram_username, r.original_filename
      FROM sales sa
      LEFT JOIN products p ON p.id = sa.product_id
      JOIN sellers s ON s.id = sa.seller_id
      LEFT JOIN recordings r ON r.id = sa.recording_id
      ORDER BY sa.created_at DESC
      LIMIT 500
    `;
    return c.json({ sales: rows });
  });

  app.get("/:id/evidence", async (c) => {
    const id = c.req.param("id");
    const evidence = await sql`
      SELECT * FROM sale_evidence WHERE sale_id = ${id} ORDER BY created_at ASC
    `;
    const sale = await sql`SELECT * FROM sales WHERE id = ${id}`;
    if (!sale[0]) return c.json({ error: "Bulunamadı" }, 404);
    return c.json({ sale: sale[0], evidence });
  });

  /**
   * Operator review + inline field edits.
   * Accepts status and/or buyerUsername, amountTry/soldAmount, askAmount, method.
   * Returns mapped sale row + recording KPI snapshot (no re-reconcile).
   */
  app.patch("/:id/review", async (c) => {
    const id = c.req.param("id");
    let body: ReviewBody;
    try {
      body = await c.req.json<ReviewBody>();
    } catch {
      return c.json({ error: "Geçersiz JSON gövde" }, 400);
    }

    const existing = await sql<
      {
        id: string;
        recording_id: string | null;
        product_id: string | null;
        buyer_username: string | null;
        amount_cents: string | null;
        currency: string;
        status: string;
        sold_at: Date | string | null;
      }[]
    >`
      SELECT id, recording_id, product_id, buyer_username,
             amount_cents::text AS amount_cents, currency, status, sold_at
      FROM sales WHERE id = ${id}
    `;
    if (!existing[0]) return c.json({ error: "Bulunamadı" }, 404);
    const cur = existing[0];

    const hasStatus = body.status !== undefined && body.status !== null;
    const hasBuyer =
      body.buyerUsername !== undefined || body.buyer_username !== undefined;
    const hasAmount =
      body.amountTry !== undefined ||
      body.amount_try !== undefined ||
      body.soldAmount !== undefined ||
      body.sold_amount !== undefined;
    const hasAsk =
      body.askAmount !== undefined ||
      body.ask_amount !== undefined ||
      body.askAmountTry !== undefined ||
      body.ask_amount_try !== undefined;
    const hasMethod =
      body.method !== undefined ||
      body.saleMethod !== undefined ||
      body.sale_method !== undefined ||
      body.detectionMethod !== undefined ||
      body.detection_method !== undefined;
    const hasSpoken =
      body.spokenBuyerName !== undefined ||
      body.spoken_buyer_name !== undefined;

    if (
      !hasStatus &&
      !hasBuyer &&
      !hasAmount &&
      !hasAsk &&
      !hasMethod &&
      !hasSpoken
    ) {
      return c.json(
        { error: "Güncellenecek alan yok (status / alıcı / tutar / yöntem)" },
        400,
      );
    }

    let nextStatus: SaleStatus = cur.status as SaleStatus;
    if (hasStatus) {
      const st = String(body.status);
      if (!SALE_STATUSES.includes(st as SaleStatus)) {
        return c.json({ error: "Geçersiz durum" }, 400);
      }
      nextStatus = st as SaleStatus;
    }

    let nextBuyer = cur.buyer_username;
    if (hasBuyer) {
      const raw = body.buyerUsername ?? body.buyer_username;
      nextBuyer = normalizeBuyer(raw);
    }

    let nextAmountCents =
      cur.amount_cents != null && Number.isFinite(Number(cur.amount_cents))
        ? Math.round(Number(cur.amount_cents))
        : null;
    if (hasAmount) {
      const tryVal = parseTryAmount(
        body.amountTry ??
          body.amount_try ??
          body.soldAmount ??
          body.sold_amount,
      );
      if (tryVal === undefined) {
        return c.json({ error: "Geçersiz satış tutarı" }, 400);
      }
      nextAmountCents =
        tryVal == null ? null : Math.round(tryVal * 100);
    }

    let nextMethod: string | null | undefined;
    if (hasMethod) {
      const raw = String(
        body.method ??
          body.saleMethod ??
          body.sale_method ??
          body.detectionMethod ??
          body.detection_method ??
          "",
      )
        .trim()
        .toLowerCase()
        .replace(/\s+/g, "_");
      if (!raw) {
        nextMethod = null;
      } else if (!(SALE_METHODS as readonly string[]).includes(raw)) {
        return c.json(
          {
            error: `Geçersiz satış yöntemi. İzin verilen: ${SALE_METHODS.join(", ")}`,
          },
          400,
        );
      } else {
        nextMethod = raw;
      }
    }

    let nextAsk: number | null | undefined;
    if (hasAsk) {
      const askVal = parseTryAmount(
        body.askAmount ??
          body.ask_amount ??
          body.askAmountTry ??
          body.ask_amount_try,
      );
      if (askVal === undefined) {
        return c.json({ error: "Geçersiz ask tutarı" }, 400);
      }
      nextAsk = askVal;
    }

    let nextSpoken: string | null | undefined;
    if (hasSpoken) {
      const raw = body.spokenBuyerName ?? body.spoken_buyer_name;
      if (raw == null || String(raw).trim() === "") nextSpoken = null;
      else nextSpoken = String(raw).trim().slice(0, 120);
    }

    const fieldEdit =
      hasBuyer || hasAmount || hasAsk || hasMethod || hasSpoken;

    const rows = await sql<Record<string, unknown>[]>`
      UPDATE sales SET
        status = ${nextStatus},
        buyer_username = ${nextBuyer},
        amount_cents = ${nextAmountCents},
        updated_at = now()
      WHERE id = ${id}
      RETURNING *
    `;
    const saleRow = rows[0]!;

    if (cur.product_id && fieldEdit) {
      const patch: Record<string, unknown> = {
        operatorEdited: true,
        operatorEditedAt: new Date().toISOString(),
        amountKnown: nextAmountCents != null,
        buyerKnown: Boolean(nextBuyer),
        needsReview: nextStatus === "needs_review",
      };
      if (hasMethod) patch.saleMethod = nextMethod;
      if (hasAsk) patch.askAmountTry = nextAsk;
      if (hasSpoken) patch.spokenBuyerName = nextSpoken;
      if (hasBuyer && nextBuyer) {
        // Keep spoken name unless operator cleared/replaced it explicitly.
        patch.buyerKnown = true;
      }
      await sql`
        UPDATE products
        SET attributes = attributes || ${sql.json(patch)}::jsonb,
            updated_at = now()
        WHERE id = ${cur.product_id}
      `;
    } else if (cur.product_id && hasStatus) {
      await sql`
        UPDATE products
        SET attributes = attributes || ${sql.json({
          needsReview: nextStatus === "needs_review",
          operatorEdited: true,
          operatorEditedAt: new Date().toISOString(),
        })}::jsonb,
            updated_at = now()
        WHERE id = ${cur.product_id}
      `;
    }

    const mapped = await loadMappedSale(sql, id);
    const recordingId =
      cur.recording_id != null ? String(cur.recording_id) : null;
    const kpis = recordingId
      ? await loadRecordingSaleKpis(sql, recordingId)
      : null;

    return c.json({ sale: mapped ?? saleRow, kpis });
  });

  return app;
}

function normalizeBuyer(raw: unknown): string | null {
  if (raw == null) return null;
  const s = String(raw).trim().replace(/^@+/, "");
  if (!s) return null;
  // Instagram usernames: letters, digits, . _
  if (!/^[A-Za-z0-9._]{1,30}$/.test(s)) {
    // Still persist trimmed handle-like text; strip spaces
    const cleaned = s.replace(/\s+/g, "").slice(0, 30);
    return cleaned || null;
  }
  return s.toLowerCase();
}

/** Parse TRY amount; `undefined` = invalid, `null` = clear. */
function parseTryAmount(raw: unknown): number | null | undefined {
  if (raw === null || raw === "") return null;
  if (raw === undefined) return undefined;
  if (typeof raw === "string") {
    const t = raw.trim().replace(/\s/g, "").replace(",", ".");
    if (!t) return null;
    const n = Number(t);
    if (!Number.isFinite(n) || n < 0) return undefined;
    return n;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return n;
}

async function loadRecordingSaleKpis(sql: Sql, recordingId: string) {
  const [row] = await sql<
    {
      confirmed_count: string;
      needs_review_count: string;
      rejected_count: string;
      sum_amount_cents: string | null;
    }[]
  >`
    SELECT
      COUNT(*) FILTER (WHERE status = 'confirmed')::text AS confirmed_count,
      COUNT(*) FILTER (WHERE status = 'needs_review')::text AS needs_review_count,
      COUNT(*) FILTER (WHERE status = 'rejected')::text AS rejected_count,
      COALESCE(
        SUM(amount_cents) FILTER (WHERE status = 'confirmed'),
        0
      )::text AS sum_amount_cents
    FROM sales
    WHERE recording_id = ${recordingId}
  `;
  const confirmedCount = Number(row?.confirmed_count ?? 0);
  const needsReviewCount = Number(row?.needs_review_count ?? 0);
  const rejectedCount = Number(row?.rejected_count ?? 0);
  const sumCents = Number(row?.sum_amount_cents ?? 0);
  const soldSum = Number.isFinite(sumCents) ? sumCents / 100 : 0;
  return {
    confirmedCount,
    needsReviewCount,
    rejectedCount,
    saleCount: confirmedCount + needsReviewCount,
    productsSoldCount: confirmedCount,
    productsSold: confirmedCount,
    productsSoldSumTry: soldSum,
    totalSoldTry: soldSum,
    sumAmountTry: soldSum,
  };
}

async function loadMappedSale(sql: Sql, id: string) {
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
    WHERE sa.id = ${id}
  `;
  const s = sales[0];
  if (!s) return null;
  const productId = s.product_id != null ? String(s.product_id) : null;
  const attrs =
    s.product_attributes && typeof s.product_attributes === "object"
      ? (s.product_attributes as Record<string, unknown>)
      : null;
  const imagePath =
    attrs && typeof attrs.imagePath === "string" ? attrs.imagePath : null;
  const saleMethod =
    attrs && typeof attrs.saleMethod === "string" ? attrs.saleMethod : null;
  const spokenBuyerName =
    attrs && typeof attrs.spokenBuyerName === "string"
      ? attrs.spokenBuyerName
      : null;
  const askAmountTry =
    attrs && attrs.askAmountTry != null && Number.isFinite(Number(attrs.askAmountTry))
      ? Number(attrs.askAmountTry)
      : null;
  const offsetMs =
    attrs && attrs.offsetMs != null && Number.isFinite(Number(attrs.offsetMs))
      ? Number(attrs.offsetMs)
      : null;
  const confidence =
    attrs && attrs.confidence != null && Number.isFinite(Number(attrs.confidence))
      ? Number(attrs.confidence)
      : null;
  const evidenceQuote =
    attrs && typeof attrs.evidenceQuote === "string"
      ? attrs.evidenceQuote
      : null;

  return {
    id: String(s.id),
    productId,
    productTitle: s.product_title != null ? String(s.product_title) : null,
    productDescription:
      s.product_description != null ? String(s.product_description) : null,
    thumbnailUrl:
      productId && imagePath ? `/api/products/${productId}/image` : null,
    buyerUsername:
      s.buyer_username != null ? String(s.buyer_username) : null,
    spokenBuyerName,
    amountCents: s.amount_cents != null ? Number(s.amount_cents) : null,
    amountTry: s.amount_cents != null ? Number(s.amount_cents) / 100 : null,
    askAmountTry,
    currency: String(s.currency ?? "TRY"),
    saleMethod,
    detectionMethod: saleMethod,
    soldAt:
      s.sold_at instanceof Date
        ? s.sold_at.toISOString()
        : s.sold_at != null
          ? String(s.sold_at)
          : null,
    offsetMs,
    confidence,
    status: String(s.status),
    evidenceQuote,
    operatorEdited: attrs?.operatorEdited === true,
  };
}

function csvEscape(v: string) {
  if (/[",\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}
