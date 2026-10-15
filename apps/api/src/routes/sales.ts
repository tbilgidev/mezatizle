import { Hono } from "hono";
import type { Sql } from "@mezatizle/db";
import { explainSaleTr } from "@mezatizle/shared";

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
    const recordingId = c.req.query("recordingId");
    const rows = recordingId
      ? await sql`
          SELECT sa.*, p.title AS product_title, s.instagram_username, r.original_filename
          FROM sales sa
          LEFT JOIN products p ON p.id = sa.product_id
          JOIN sellers s ON s.id = sa.seller_id
          LEFT JOIN recordings r ON r.id = sa.recording_id
          WHERE sa.recording_id = ${recordingId}
          ORDER BY sa.created_at DESC
          LIMIT 500
        `
      : await sql`
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
    const sale = await sql<Record<string, unknown>[]>`
      SELECT sa.*, p.title AS product_title, p.attributes AS product_attributes,
             s.instagram_username, r.original_filename, r.duration_seconds
      FROM sales sa
      LEFT JOIN products p ON p.id = sa.product_id
      JOIN sellers s ON s.id = sa.seller_id
      LEFT JOIN recordings r ON r.id = sa.recording_id
      WHERE sa.id = ${id}
    `;
    if (!sale[0]) return c.json({ error: "Bulunamadı" }, 404);

    const evidence = await sql<Record<string, unknown>[]>`
      SELECT * FROM sale_evidence WHERE sale_id = ${id} ORDER BY created_at ASC
    `;

    // Resolve timeline from linked auction event (+ nearby transcript/OCR)
    let offsetMs: number | null = null;
    let auctionEvent: Record<string, unknown> | null = null;
    const primary = evidence.find((e) => e.evidence_type === "auction_event");
    if (primary?.ref_id) {
      const ev = await sql<Record<string, unknown>[]>`
        SELECT * FROM auction_events WHERE id = ${String(primary.ref_id)}
      `;
      auctionEvent = ev[0] ?? null;
      if (auctionEvent?.offset_ms != null) {
        offsetMs = Number(auctionEvent.offset_ms);
      }
    }

    const recordingId = String(sale[0].recording_id ?? "");
    const windowMs = Number(process.env.EVIDENCE_WINDOW_MS ?? "20000");
    let transcriptAround: Array<Record<string, unknown>> = [];
    let commentsAround: Array<Record<string, unknown>> = [];
    if (recordingId && offsetMs != null) {
      transcriptAround = await sql`
        SELECT id, start_ms, end_ms, text, confidence, source
        FROM transcript_segments
        WHERE recording_id = ${recordingId}
          AND start_ms BETWEEN ${offsetMs - windowMs} AND ${offsetMs + windowMs}
        ORDER BY start_ms ASC
        LIMIT 40
      `;
      commentsAround = await sql`
        SELECT id, offset_ms, author_username, body, source
        FROM observed_comments
        WHERE recording_id = ${recordingId}
          AND COALESCE(offset_ms, 0) BETWEEN ${offsetMs - windowMs} AND ${offsetMs + windowMs}
        ORDER BY COALESCE(offset_ms, 0) ASC
        LIMIT 40
      `;
    }

    const conf = Number(
      (primary?.payload as { confidence?: number } | undefined)?.confidence ??
        auctionEvent?.confidence ??
        0,
    );
    const reason =
      (primary?.payload as { reason?: string } | undefined)?.reason ??
      (auctionEvent?.payload as { reason?: string } | undefined)?.reason ??
      null;
    const gaps =
      (primary?.payload as { gaps?: string[] } | undefined)?.gaps ??
      ((sale[0].product_attributes as { gaps?: string[] } | undefined)?.gaps ??
        []);
    const explanationTr =
      (primary?.payload as { explanationTr?: string } | undefined)
        ?.explanationTr ??
      explainSaleTr({
        confidence: conf,
        reason,
        buyer:
          sale[0].buyer_username != null
            ? String(sale[0].buyer_username)
            : null,
        amountCents:
          sale[0].amount_cents != null ? Number(sale[0].amount_cents) : null,
        gaps,
      });

    return c.json({
      sale: sale[0],
      evidence,
      auctionEvent,
      offsetMs,
      transcriptAround,
      commentsAround,
      explanationTr,
      confidence: conf,
      gaps,
      windowMs,
    });
  });

  app.patch("/:id/review", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json<{ status: string }>();
    const allowed = ["needs_review", "confirmed", "rejected", "candidate"];
    if (!allowed.includes(body.status)) {
      return c.json({ error: "Geçersiz durum" }, 400);
    }
    const rows = await sql`
      UPDATE sales SET status = ${body.status}, updated_at = now()
      WHERE id = ${id}
      RETURNING *
    `;
    if (!rows[0]) return c.json({ error: "Bulunamadı" }, 404);
    return c.json({ sale: rows[0] });
  });

  return app;
}

function csvEscape(v: string) {
  if (/[",\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}
