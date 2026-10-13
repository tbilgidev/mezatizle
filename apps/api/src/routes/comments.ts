import { Hono } from "hono";
import type { Sql } from "@mezatizle/db";

/** Operator-provided comment export only — no Instagram scraping. */
export function commentsRoutes(sql: Sql) {
  const app = new Hono();

  app.post("/import", async (c) => {
    const body = await c.req.json<{
      recordingId: string;
      comments: Array<{
        body: string;
        authorUsername?: string;
        offsetMs?: number;
        observedAt?: string;
      }>;
    }>();
    if (!body.recordingId || !Array.isArray(body.comments)) {
      return c.json({ error: "recordingId ve comments gerekli" }, 400);
    }
    const rec = await sql`SELECT id FROM recordings WHERE id = ${body.recordingId}`;
    if (!rec[0]) return c.json({ error: "Kayıt bulunamadı" }, 404);

    let n = 0;
    for (const item of body.comments) {
      if (!item.body?.trim()) continue;
      await sql`
        INSERT INTO observed_comments (
          recording_id, observed_at, offset_ms, author_username, body, source
        ) VALUES (
          ${body.recordingId},
          ${item.observedAt ?? null},
          ${item.offsetMs ?? null},
          ${item.authorUsername ?? null},
          ${item.body.trim()},
          ${"operator_export"}
        )
      `;
      n++;
    }
    return c.json({ imported: n });
  });

  app.get("/:recordingId", async (c) => {
    const recordingId = c.req.param("recordingId");
    const rows = await sql`
      SELECT * FROM observed_comments WHERE recording_id = ${recordingId}
      ORDER BY COALESCE(offset_ms, 0) ASC
    `;
    return c.json({ comments: rows });
  });

  return app;
}
