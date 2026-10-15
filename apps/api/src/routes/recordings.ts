import { Hono } from "hono";
import type { Sql } from "@mezatizle/db";
import type { AppEnv } from "../lib/env.ts";
import { createRecordingFromUpload } from "../modules/ingestion.ts";
import {
  cancelLiveCapture,
  createLiveCapture,
  LIVE_CAPTURE_POLICY,
} from "../modules/live_capture.ts";
import { safeJoinStorage } from "../lib/storage.ts";
import { streamFileWithRanges } from "../lib/media-stream.ts";
import { probeAvSync } from "../lib/ffmpeg.ts";

export function recordingsRoutes(sql: Sql, env: AppEnv) {
  const app = new Hono();

  app.get("/", async (c) => {
    const rows = await sql`
      SELECT r.*, s.instagram_username, s.display_name,
             lc.status AS live_status, lc.attempt_count, lc.last_probe_detail
      FROM recordings r
      JOIN sellers s ON s.id = r.seller_id
      LEFT JOIN live_captures lc ON lc.recording_id = r.id
      ORDER BY r.uploaded_at DESC
      LIMIT 200
    `;
    return c.json({ recordings: rows });
  });

  app.post("/live", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      input?: string;
      displayName?: string;
      notes?: string;
      maxDurationMinutes?: number | string | null;
    };
    if (!body.input?.trim()) {
      return c.json(
        { error: "Canlı yayın bağlantısı veya @kullanıcı adı gerekli" },
        400,
      );
    }
    const rawDur = body.maxDurationMinutes;
    const maxDurationMinutes =
      rawDur === "" || rawDur == null
        ? null
        : Number(rawDur);
    try {
      const result = await createLiveCapture(sql, env, {
        input: body.input,
        displayName: body.displayName,
        notes: body.notes,
        maxDurationMinutes: Number.isFinite(maxDurationMinutes as number)
          ? (maxDurationMinutes as number)
          : null,
      });
      return c.json(result, 201);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg, policy: LIVE_CAPTURE_POLICY }, 400);
    }
  });

  app.post("/:id/cancel-live", async (c) => {
    const id = c.req.param("id");
    try {
      const result = await cancelLiveCapture(sql, id);
      return c.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, 400);
    }
  });

  app.get("/:id", async (c) => {
    const id = c.req.param("id");
    const rows = await sql`
      SELECT r.*, s.instagram_username
      FROM recordings r
      JOIN sellers s ON s.id = r.seller_id
      WHERE r.id = ${id}
    `;
    if (!rows[0]) return c.json({ error: "Bulunamadı" }, 404);
    const jobs = await sql`
      SELECT id, job_type, status, progress_percent, stage, error_message, created_at, finished_at
      FROM processing_jobs WHERE recording_id = ${id}
      ORDER BY priority ASC, created_at ASC
    `;
    return c.json({ recording: rows[0], jobs });
  });

  app.post("/upload", async (c) => {
    const body = await c.req.parseBody();
    const file = body["file"];
    const seller = String(body["sellerInstagramUsername"] ?? "");
    const recordedAt = String(body["recordedAt"] ?? "");
    const notes = body["notes"] ? String(body["notes"]) : undefined;
    if (!(file instanceof File)) {
      return c.json({ error: "file alanı gerekli (multipart)" }, 400);
    }
    try {
      const result = await createRecordingFromUpload(sql, env, {
        file,
        sellerInstagramUsername: seller,
        recordedAt,
        notes,
      });
      return c.json(result, 201);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, 400);
    }
  });

  app.get("/:id/transcript", async (c) => {
    const id = c.req.param("id");
    const rows = await sql`
      SELECT * FROM transcript_segments WHERE recording_id = ${id}
      ORDER BY start_ms ASC
    `;
    return c.json({ segments: rows });
  });

  app.get("/:id/events", async (c) => {
    const id = c.req.param("id");
    const rows = await sql`
      SELECT * FROM auction_events WHERE recording_id = ${id}
      ORDER BY COALESCE(offset_ms, 0) ASC
    `;
    return c.json({ events: rows });
  });

  app.get("/:id/jobs", async (c) => {
    const id = c.req.param("id");
    const rows = await sql`
      SELECT * FROM processing_jobs WHERE recording_id = ${id}
      ORDER BY priority ASC
    `;
    return c.json({ jobs: rows });
  });

  /** Master MP4 — byte-range friendly for Kanıt / Raporlar seek (read-only). */
  app.get("/:id/media", async (c) => {
    const id = c.req.param("id");
    const rows = await sql<{ storage_path: string }[]>`
      SELECT storage_path FROM recordings WHERE id = ${id}
    `;
    if (!rows[0]) return c.json({ error: "Bulunamadı" }, 404);
    try {
      const abs = safeJoinStorage(env.storageRoot, rows[0].storage_path);
      return streamFileWithRanges(abs, c.req.raw, "video/mp4");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, 400);
    }
  });

  /** A/V sync diagnostic on master timeline. */
  app.get("/:id/av-sync", async (c) => {
    const id = c.req.param("id");
    const rows = await sql<{ storage_path: string }[]>`
      SELECT storage_path FROM recordings WHERE id = ${id}
    `;
    if (!rows[0]) return c.json({ error: "Bulunamadı" }, 404);
    try {
      const abs = safeJoinStorage(env.storageRoot, rows[0].storage_path);
      const sync = await probeAvSync(env.ffprobePath, abs);
      return c.json({ recordingId: id, sync });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, 400);
    }
  });

  return app;
}
