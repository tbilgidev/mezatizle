import { Hono } from "hono";
import { access, constants } from "node:fs/promises";
import type { Sql } from "@mezatizle/db";
import type { AppEnv } from "../lib/env.ts";
import { createRecordingFromUpload } from "../modules/ingestion.ts";
import {
  cancelLiveCapture,
  createLiveCapture,
  LIVE_CAPTURE_POLICY,
} from "../modules/live_capture.ts";
import { safeJoinStorage } from "../lib/storage.ts";

/** Serve muxed recording MP4 with Accept-Ranges (for evidence seek + audio). */
async function serveRecordingMedia(
  c: { req: { header: (n: string) => string | undefined; method: string } },
  absPath: string,
): Promise<Response> {
  try {
    await access(absPath, constants.R_OK);
  } catch {
    return new Response(JSON.stringify({ error: "Medya dosyası yok" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }
  const file = Bun.file(absPath);
  const size = file.size;
  const range = c.req.header("range") ?? c.req.header("Range");
  const baseHeaders: Record<string, string> = {
    "Content-Type": "video/mp4",
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=120",
  };

  if (c.req.method === "HEAD") {
    return new Response(null, {
      status: 200,
      headers: { ...baseHeaders, "Content-Length": String(size) },
    });
  }

  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/i.exec(range.trim());
    if (!m) {
      return new Response("Invalid Range", {
        status: 416,
        headers: { ...baseHeaders, "Content-Range": `bytes */${size}` },
      });
    }
    let start = m[1] ? Number(m[1]) : 0;
    let end = m[2] ? Number(m[2]) : size - 1;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0) {
      return new Response("Invalid Range", {
        status: 416,
        headers: { ...baseHeaders, "Content-Range": `bytes */${size}` },
      });
    }
    if (end >= size) end = size - 1;
    if (start > end) {
      return new Response("Invalid Range", {
        status: 416,
        headers: { ...baseHeaders, "Content-Range": `bytes */${size}` },
      });
    }
    const chunk = file.slice(start, end + 1);
    return new Response(chunk, {
      status: 206,
      headers: {
        ...baseHeaders,
        "Content-Length": String(end - start + 1),
        "Content-Range": `bytes ${start}-${end}/${size}`,
      },
    });
  }

  return new Response(file, {
    status: 200,
    headers: { ...baseHeaders, "Content-Length": String(size) },
  });
}

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

  /** Muxed MP4 stream (video+audio) for evidence review — not OCR frame dumps. */
  app.on(["GET", "HEAD"], "/:id/media", async (c) => {
    const id = c.req.param("id");
    const rows = await sql<{ storage_path: string }[]>`
      SELECT storage_path FROM recordings WHERE id = ${id}
    `;
    if (!rows[0]?.storage_path) {
      return c.json({ error: "Kayıt bulunamadı" }, 404);
    }
    let abs: string;
    try {
      abs = safeJoinStorage(env.storageRoot, String(rows[0].storage_path));
    } catch {
      return c.json({ error: "Güvensiz medya yolu" }, 400);
    }
    return serveRecordingMedia(c, abs);
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

  return app;
}
