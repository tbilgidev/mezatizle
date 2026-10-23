import { Hono } from "hono";
import type { Sql } from "@mezatizle/db";
import type { AppEnv } from "../lib/env.ts";
import { createRecordingFromUpload } from "../modules/ingestion.ts";
import {
  cancelLiveCapture,
  createLiveCapture,
  cutoverLiveCapture,
  resumeBlockedLiveCapture,
  runCaptureStallWatchdogTick,
  stopLiveCaptureAndAnalyze,
  LIVE_CAPTURE_POLICY,
} from "../modules/live_capture.ts";
import { safeJoinStorage } from "../lib/storage.ts";
import { streamFileWithRanges } from "../lib/media-stream.ts";
import { probeAvSync } from "../lib/ffmpeg.ts";
import { enrichRecordingRow } from "../lib/recording-enrich.ts";
import {
  bulkDeleteRecordings,
  deleteRecording,
  deleteOrphanSellers,
} from "../modules/recording-delete.ts";
import {
  isMediaPurged,
  mediaPurgedNoteTr,
  mediaRetentionDaysFromEnv,
} from "../modules/media_retention.ts";

export function recordingsRoutes(sql: Sql, env: AppEnv) {
  const app = new Hono();

  app.get("/", async (c) => {
    const rows = await sql`
      SELECT r.*, s.instagram_username, s.display_name,
             lc.status AS live_status, lc.attempt_count, lc.last_probe_detail,
             lc.last_probe_at, lc.last_probe_detail AS last_error,
             lc.comments_warning,
             (SELECT COUNT(*)::int FROM observed_comments oc
               WHERE oc.recording_id = r.id
                 AND oc.source IN ('live_api', 'live_dom')) AS live_comment_count,
             (SELECT COUNT(*)::int FROM observed_comments oc
               WHERE oc.recording_id = r.id) AS comment_count,
             (SELECT EXTRACT(EPOCH FROM (now() - MAX(coalesce(oc.observed_at, oc.created_at))))::int
               FROM observed_comments oc
               WHERE oc.recording_id = r.id
                 AND oc.source IN ('live_api', 'live_dom')) AS last_comment_age_sec
      FROM recordings r
      JOIN sellers s ON s.id = r.seller_id
      LEFT JOIN live_captures lc ON lc.recording_id = r.id
      ORDER BY r.uploaded_at DESC
      LIMIT 200
    `;
    // Prefer explicit capture_error for UI; fall back to probe detail.
    // Heal file_size_bytes from finalized MP4 on disk (sizeTimer can race to 0).
    const recordings = await Promise.all(
      rows.map(async (r) => {
        const enriched = await enrichRecordingRow(
          env,
          sql,
          r as Record<string, unknown>,
        );
        return {
          ...enriched,
          lastError:
            (enriched.capture_error as string | null) ??
            (enriched.last_probe_detail as string | null) ??
            null,
        };
      }),
    );
    return c.json({ recordings });
  });

  /** Bulk delete — register before /:id so path is not swallowed. */
  app.post("/bulk-delete", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      ids?: unknown;
    };
    const ids = Array.isArray(body.ids)
      ? body.ids.map((x) => String(x)).filter(Boolean)
      : [];
    if (!ids.length) {
      return c.json({ error: "ids dizisi gerekli" }, 400);
    }
    if (ids.length > 200) {
      return c.json({ error: "En fazla 200 kayıt silinebilir" }, 400);
    }
    try {
      const result = await bulkDeleteRecordings(sql, env, ids);
      const deletedCount = result.deleted.filter((d) => d.deleted).length;
      return c.json({
        ok: true,
        deletedCount,
        orphanSellersRemoved: result.orphanSellersRemoved,
        results: result.deleted,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, 500);
    }
  });

  /** Durable stall watchdog nudge (systemd timer → this route). */
  app.post("/stall-watchdog-tick", async (c) => {
    try {
      // In-API: may finalize part1 and start part2 under this process.
      await runCaptureStallWatchdogTick(sql, env, { allowPart2: true });
      return c.json({ ok: true, ran: true }, 200);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ ok: false, error: msg }, 500);
    }
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

  /**
   * Operator cutover: stop current (finalize+analyze) then start new capture.
   * Must be registered before /:id routes. Body: { input, stopRecordingId?, … }
   */
  app.post("/cutover", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      input?: string;
      stopRecordingId?: string;
      displayName?: string;
      notes?: string;
      maxDurationMinutes?: number | string | null;
    };
    if (!body.input?.trim()) {
      return c.json(
        { error: "Yeni canlı link veya @kullanıcı adı gerekli" },
        400,
      );
    }
    const rawDur = body.maxDurationMinutes;
    const maxDurationMinutes =
      rawDur === "" || rawDur == null ? null : Number(rawDur);
    try {
      const result = await cutoverLiveCapture(sql, env, {
        input: body.input,
        stopRecordingId: body.stopRecordingId,
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

  /**
   * Operator early cut: finalize MP4 + enqueue analysis (does not discard).
   * Use before starting a different live while one is kaydediliyor.
   */
  app.post("/:id/stop-live", async (c) => {
    const id = c.req.param("id");
    try {
      const result = await stopLiveCaptureAndAnalyze(sql, env, id);
      return c.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, 400);
    }
  });

  /** After refreshing IG cookies: blocked/not_found → waiting again. */
  app.post("/:id/retry-live", async (c) => {
    const id = c.req.param("id");
    try {
      const result = await resumeBlockedLiveCapture(sql, id);
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
    const recording = await enrichRecordingRow(
      env,
      sql,
      rows[0] as Record<string, unknown>,
    );
    return c.json({ recording, jobs });
  });

  app.delete("/:id", async (c) => {
    const id = c.req.param("id");
    try {
      const result = await deleteRecording(sql, env, id);
      if (!result.deleted) {
        return c.json({ error: "Bulunamadı", ...result }, 404);
      }
      const orphanSellersRemoved = await deleteOrphanSellers(sql);
      return c.json({
        ok: true,
        ...result,
        orphanSellersRemoved,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, 500);
    }
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
  app.on(["GET", "HEAD"], "/:id/media", async (c) => {
    const id = c.req.param("id");
    const rows = await sql<
      { storage_path: string; media_purged_at: Date | string | null }[]
    >`
      SELECT storage_path, media_purged_at FROM recordings WHERE id = ${id}
    `;
    if (!rows[0]) return c.json({ error: "Bulunamadı" }, 404);
    if (isMediaPurged(rows[0])) {
      const note = mediaPurgedNoteTr(mediaRetentionDaysFromEnv());
      return c.json(
        {
          error: "media_purged",
          mediaPurged: true,
          message: note,
          noteTr: note,
        },
        410,
      );
    }
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
