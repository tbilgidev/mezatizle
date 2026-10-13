import { Hono } from "hono";
import type { Sql } from "@mezatizle/db";

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
