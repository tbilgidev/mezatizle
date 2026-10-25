/**
 * Auto-delete recording VIDEO files N days after analysis completes/fails.
 * Keeps DB rows: sales, KPIs, observed_comments, transcript_segments, product thumbs.
 * Never touches active captures (bekleniyor / kaydediliyor) or storage/secrets.
 */
import { access, readdir, rm, unlink, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { basename, join } from "node:path";
import type { Sql } from "@mezatizle/db";
import type { AppEnv } from "../lib/env.ts";
import { safeJoinStorage } from "../lib/storage.ts";

export const MEDIA_RETENTION_DAYS_DEFAULT = 7;

/** Exact operator-facing note when media is gone (default 7-day policy). */
export const MEDIA_PURGED_NOTE_TR =
  "Video 1 hafta sonra silindi; analiz duruyor";

export function mediaPurgedNoteTr(retentionDays = MEDIA_RETENTION_DAYS_DEFAULT): string {
  if (retentionDays === 7) return MEDIA_PURGED_NOTE_TR;
  return `Video ${retentionDays} gün sonra silindi; analiz duruyor`;
}

export function mediaRetentionDaysFromEnv(
  raw: string | undefined = process.env.MEDIA_RETENTION_DAYS,
): number {
  const n = Number(raw ?? MEDIA_RETENTION_DAYS_DEFAULT);
  if (!Number.isFinite(n) || n < 1) return MEDIA_RETENTION_DAYS_DEFAULT;
  return Math.min(3650, Math.floor(n));
}

export type MediaRetentionPolicy = {
  retentionDays: number;
  noteTr: string;
  labelTr: string;
  hintTr: string;
  deletes: string[];
  keeps: string[];
  knownGapTr: string;
};

export function mediaRetentionPolicy(
  retentionDays = mediaRetentionDaysFromEnv(),
): MediaRetentionPolicy {
  return {
    retentionDays,
    noteTr: mediaPurgedNoteTr(retentionDays),
    labelTr: `Video saklama: ${retentionDays} gün`,
    hintTr: `Analiz tamamlandıktan (veya kalıcı başarısız olduktan) ${retentionDays} gün sonra kayıt videosu (MP4), parça dosyaları, ASS yan dosyası, ham ses/kareler silinir. Satışlar, rapor KPI’ları, yorum metinleri, transkript ve ürün küçük resimleri kalır.`,
    deletes: [
      "MP4 master / .part.mp4",
      "comments ASS sidecar",
      "audio/*.wav",
      "frames/<id>/ (ham OCR kareleri)",
    ],
    keeps: [
      "sales + sale_evidence",
      "report KPIs",
      "observed_comments",
      "transcript_segments",
      "products (+ thumbs under storage/products)",
      "recording DB row",
    ],
    knownGapTr:
      "Instagram canlıları platform süre sınırından sonra yeniden başlayabilir; ileride çok parçalı (multi-segment) yakalama gerekebilir — şimdilik tek oturum kaydı.",
  };
}

const TERMINAL_STATUSES = ["complete", "failed", "cancelled"] as const;
const ACTIVE_CAPTURE = ["bekleniyor", "kaydediliyor"] as const;
const ACTIVE_LIVE_CAPTURE = [
  "pending",
  "waiting",
  "recording",
  "finalizing",
] as const;

export type PurgeCandidate = {
  id: string;
  status: string;
  captureStatus: string | null;
  storagePath: string;
  updatedAt: string;
  analysisFinishedAt: string | null;
  ageAnchorAt: string;
  mediaPurgedAt: string | null;
  fileSizeBytes: number | null;
};

export type MediaPathPlan = {
  abs: string;
  kind: "mp4" | "part" | "ass" | "wav" | "frames_dir" | "other";
  exists: boolean;
  sizeBytes: number;
};

export type PurgeRecordingResult = {
  recordingId: string;
  eligible: boolean;
  skippedReason?: string;
  dryRun: boolean;
  files: MediaPathPlan[];
  filesRemoved: string[];
  bytesRemoved: number;
  mediaPurgedAt?: string | null;
};

async function pathExists(abs: string): Promise<boolean> {
  try {
    await access(abs, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function fileSize(abs: string): Promise<number> {
  try {
    const st = await stat(abs);
    return st.isFile() || st.isDirectory() ? st.size : 0;
  } catch {
    return 0;
  }
}

async function dirTreeBytes(abs: string): Promise<number> {
  try {
    const st = await stat(abs);
    if (st.isFile()) return st.size;
    if (!st.isDirectory()) return 0;
    const entries = await readdir(abs, { withFileTypes: true });
    let total = 0;
    for (const e of entries) {
      const child = join(abs, e.name);
      if (e.isDirectory()) total += await dirTreeBytes(child);
      else if (e.isFile()) total += (await fileSize(child)) || 0;
    }
    return total;
  } catch {
    return 0;
  }
}

/**
 * Build list of media artifacts safe to delete (never products/ or secrets/).
 */
export async function planMediaPaths(
  env: AppEnv,
  recordingId: string,
  storagePath: string,
): Promise<MediaPathPlan[]> {
  const out: MediaPathPlan[] = [];
  const push = async (relParts: string[], kind: MediaPathPlan["kind"]) => {
    try {
      const abs = safeJoinStorage(env.storageRoot, ...relParts);
      // Refuse anything under secrets/ or products/
      const norm = abs.replace(/\\/g, "/");
      if (norm.includes("/secrets/") || norm.includes("/products/")) return;
      const exists = await pathExists(abs);
      let sizeBytes = 0;
      if (exists) {
        sizeBytes =
          kind === "frames_dir"
            ? await dirTreeBytes(abs)
            : await fileSize(abs);
      }
      out.push({ abs, kind, exists, sizeBytes });
    } catch {
      /* bad path — skip */
    }
  };

  const sp = String(storagePath || "").replace(/^\/+/, "");
  if (sp) {
    const parts = sp.split("/").filter(Boolean);
    await push(parts, "mp4");
    // part next to master: <storage_path>.part.mp4
    try {
      const mp4 = safeJoinStorage(env.storageRoot, ...parts);
      const part = `${mp4}.part.mp4`;
      const exists = await pathExists(part);
      out.push({
        abs: part,
        kind: "part",
        exists,
        sizeBytes: exists ? await fileSize(part) : 0,
      });
    } catch {
      /* skip */
    }
  }

  // ASS sidecars (comments burn-in)
  await push(["recordings", `${recordingId}.comments.ass`], "ass");
  await push(["recordings", `${recordingId}.mp4.comments.ass`], "ass");
  // If storage basename differs
  if (sp) {
    const base = basename(sp).replace(/\.mp4$/i, "");
    if (base && base !== recordingId) {
      await push(["recordings", `${base}.comments.ass`], "ass");
    }
  }

  await push(["audio", `${recordingId}.wav`], "wav");
  await push(["frames", recordingId], "frames_dir");

  // Dedupe by abs
  const seen = new Set<string>();
  return out.filter((p) => {
    if (seen.has(p.abs)) return false;
    seen.add(p.abs);
    return true;
  });
}

export async function listPurgeCandidates(
  sql: Sql,
  retentionDays: number,
): Promise<PurgeCandidate[]> {
  const days = Math.max(0, Math.floor(retentionDays));
  const rows = await sql<
    {
      id: string;
      status: string;
      capture_status: string | null;
      storage_path: string;
      updated_at: Date | string;
      analysis_finished_at: Date | string | null;
      age_anchor_at: Date | string;
      media_purged_at: Date | string | null;
      file_size_bytes: number | string | null;
    }[]
  >`
    SELECT
      r.id,
      r.status,
      r.capture_status,
      r.storage_path,
      r.updated_at,
      r.media_purged_at,
      r.file_size_bytes,
      j.analysis_finished_at,
      COALESCE(j.analysis_finished_at, r.updated_at) AS age_anchor_at
    FROM recordings r
    LEFT JOIN LATERAL (
      SELECT MAX(finished_at) AS analysis_finished_at
      FROM processing_jobs pj
      WHERE pj.recording_id = r.id
        AND pj.status IN ('succeeded', 'failed', 'cancelled')
        AND pj.finished_at IS NOT NULL
    ) j ON TRUE
    WHERE r.media_purged_at IS NULL
      AND r.status = ANY(${[...TERMINAL_STATUSES]}::text[])
      AND (r.capture_status IS NULL OR NOT (r.capture_status = ANY(${[...ACTIVE_CAPTURE]}::text[])))
      AND NOT EXISTS (
        SELECT 1 FROM live_captures lc
        WHERE lc.recording_id = r.id
          AND lc.status = ANY(${[...ACTIVE_LIVE_CAPTURE]}::text[])
      )
      AND COALESCE(j.analysis_finished_at, r.updated_at)
          < now() - make_interval(days => ${days})
    ORDER BY age_anchor_at ASC
  `;

  return rows.map((r) => ({
    id: String(r.id),
    status: String(r.status),
    captureStatus: r.capture_status != null ? String(r.capture_status) : null,
    storagePath: String(r.storage_path),
    updatedAt: new Date(r.updated_at).toISOString(),
    analysisFinishedAt: r.analysis_finished_at
      ? new Date(r.analysis_finished_at).toISOString()
      : null,
    ageAnchorAt: new Date(r.age_anchor_at).toISOString(),
    mediaPurgedAt: r.media_purged_at
      ? new Date(r.media_purged_at).toISOString()
      : null,
    fileSizeBytes:
      r.file_size_bytes != null && Number.isFinite(Number(r.file_size_bytes))
        ? Number(r.file_size_bytes)
        : null,
  }));
}

async function safeUnlink(path: string, removed: string[]): Promise<number> {
  try {
    const size = await fileSize(path);
    await unlink(path);
    removed.push(path);
    return size;
  } catch {
    return 0;
  }
}

async function safeRmDir(path: string, removed: string[]): Promise<number> {
  try {
    const size = await dirTreeBytes(path);
    await rm(path, { recursive: true, force: true });
    removed.push(path);
    return size;
  } catch {
    return 0;
  }
}

/**
 * Guard: refuse purge if capture is still active (defense in depth).
 */
export async function assertSafeToPurgeMedia(
  sql: Sql,
  recordingId: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const [row] = await sql<
    {
      status: string;
      capture_status: string | null;
      media_purged_at: Date | string | null;
    }[]
  >`
    SELECT status, capture_status, media_purged_at
    FROM recordings WHERE id = ${recordingId}
  `;
  if (!row) return { ok: false, reason: "not_found" };
  if (row.media_purged_at) return { ok: false, reason: "already_purged" };
  if (!TERMINAL_STATUSES.includes(row.status as (typeof TERMINAL_STATUSES)[number])) {
    return { ok: false, reason: `status_${row.status}` };
  }
  const cap = row.capture_status != null ? String(row.capture_status) : "";
  if ((ACTIVE_CAPTURE as readonly string[]).includes(cap)) {
    return { ok: false, reason: `capture_${cap}` };
  }
  const [live] = await sql<{ status: string }[]>`
    SELECT status FROM live_captures
    WHERE recording_id = ${recordingId}
      AND status = ANY(${[...ACTIVE_LIVE_CAPTURE]}::text[])
    LIMIT 1
  `;
  if (live) return { ok: false, reason: `live_capture_${live.status}` };
  return { ok: true };
}

export async function purgeRecordingMedia(
  sql: Sql,
  env: AppEnv,
  recordingId: string,
  opts?: { dryRun?: boolean },
): Promise<PurgeRecordingResult> {
  const dryRun = Boolean(opts?.dryRun);
  const guard = await assertSafeToPurgeMedia(sql, recordingId);
  if (!guard.ok) {
    return {
      recordingId,
      eligible: false,
      skippedReason: guard.reason,
      dryRun,
      files: [],
      filesRemoved: [],
      bytesRemoved: 0,
    };
  }

  const [rec] = await sql<{ storage_path: string }[]>`
    SELECT storage_path FROM recordings WHERE id = ${recordingId}
  `;
  if (!rec) {
    return {
      recordingId,
      eligible: false,
      skippedReason: "not_found",
      dryRun,
      files: [],
      filesRemoved: [],
      bytesRemoved: 0,
    };
  }

  const files = await planMediaPaths(env, recordingId, rec.storage_path);
  const existing = files.filter((f) => f.exists);
  if (!existing.length) {
    // Nothing on disk — still mark purged so UI stops offering Video links.
    if (!dryRun) {
      await sql`
        UPDATE recordings
        SET media_purged_at = COALESCE(media_purged_at, now()),
            updated_at = updated_at
        WHERE id = ${recordingId} AND media_purged_at IS NULL
      `;
    }
    const [after] = await sql<{ media_purged_at: Date | string | null }[]>`
      SELECT media_purged_at FROM recordings WHERE id = ${recordingId}
    `;
    return {
      recordingId,
      eligible: true,
      dryRun,
      files,
      filesRemoved: [],
      bytesRemoved: 0,
      mediaPurgedAt: after?.media_purged_at
        ? new Date(after.media_purged_at).toISOString()
        : dryRun
          ? null
          : new Date().toISOString(),
    };
  }

  if (dryRun) {
    return {
      recordingId,
      eligible: true,
      dryRun: true,
      files,
      filesRemoved: existing.map((f) => f.abs),
      bytesRemoved: existing.reduce((a, f) => a + f.sizeBytes, 0),
      mediaPurgedAt: null,
    };
  }

  const removed: string[] = [];
  let bytes = 0;
  for (const f of existing) {
    if (f.kind === "frames_dir") {
      bytes += await safeRmDir(f.abs, removed);
    } else {
      bytes += await safeUnlink(f.abs, removed);
    }
  }

  await sql`
    UPDATE recordings
    SET media_purged_at = now(),
        updated_at = updated_at
    WHERE id = ${recordingId} AND media_purged_at IS NULL
  `;

  const [after] = await sql<{ media_purged_at: Date | string | null }[]>`
    SELECT media_purged_at FROM recordings WHERE id = ${recordingId}
  `;

  return {
    recordingId,
    eligible: true,
    dryRun: false,
    files,
    filesRemoved: removed,
    bytesRemoved: bytes,
    mediaPurgedAt: after?.media_purged_at
      ? new Date(after.media_purged_at).toISOString()
      : new Date().toISOString(),
  };
}

export async function runMediaRetentionPurge(
  sql: Sql,
  env: AppEnv,
  opts?: { dryRun?: boolean; retentionDays?: number },
): Promise<{
  retentionDays: number;
  dryRun: boolean;
  candidates: PurgeCandidate[];
  results: PurgeRecordingResult[];
  totalBytes: number;
}> {
  const retentionDays = opts?.retentionDays ?? mediaRetentionDaysFromEnv();
  const dryRun = Boolean(opts?.dryRun);
  const candidates = await listPurgeCandidates(sql, retentionDays);
  const results: PurgeRecordingResult[] = [];
  let totalBytes = 0;
  for (const c of candidates) {
    const r = await purgeRecordingMedia(sql, env, c.id, { dryRun });
    results.push(r);
    totalBytes += r.bytesRemoved;
  }
  return { retentionDays, dryRun, candidates, results, totalBytes };
}

/** Used by UI helpers — true when media should not be offered for playback. */
export function isMediaPurged(row: {
  media_purged_at?: unknown;
  mediaPurgedAt?: unknown;
  mediaPurged?: unknown;
}): boolean {
  if (row.mediaPurged === true) return true;
  const v = row.media_purged_at ?? row.mediaPurgedAt;
  if (v == null || v === "") return false;
  return true;
}
