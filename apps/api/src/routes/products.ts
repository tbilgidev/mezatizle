/**
 * Product media — serve frame thumbnails attached at reconcile.
 * GET /api/products/:id/image
 */
import { Hono } from "hono";
import type { Sql } from "@mezatizle/db";
import type { AppEnv } from "../lib/env.ts";
import { safeJoinStorage } from "../lib/storage.ts";
import { streamFileWithRanges } from "../lib/media-stream.ts";

export function productsRoutes(sql: Sql, env: AppEnv) {
  const app = new Hono();

  app.on(["GET", "HEAD"], "/:id/image", async (c) => {
    const id = c.req.param("id");
    const rows = await sql<{ attributes: Record<string, unknown> | null }[]>`
      SELECT attributes FROM products WHERE id = ${id}
    `;
    if (!rows[0]) return c.json({ error: "Ürün bulunamadı" }, 404);
    const attrs = rows[0].attributes ?? {};
    const imagePath =
      typeof attrs.imagePath === "string" ? attrs.imagePath.trim() : "";
    if (!imagePath) {
      return c.json({ error: "Ürün görseli yok" }, 404);
    }
    try {
      // imagePath is like products/<uuid>.jpg under STORAGE_ROOT
      const abs = safeJoinStorage(env.storageRoot, imagePath);
      return streamFileWithRanges(abs, c.req.raw, "image/jpeg");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, 400);
    }
  });

  return app;
}
