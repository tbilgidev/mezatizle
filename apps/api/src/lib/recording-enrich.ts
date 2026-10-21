/**
 * Enrich recording rows for API/UI: real on-disk size + analysis progress.
 */
import { stat } from "node:fs/promises";
import type { Sql } from "@mezatizle/db";
import type { AppEnv } from "./env.ts";
import { safeJoinStorage } from "./storage.ts";
import {
  isMediaPurged,
  mediaPurgedNoteTr,
  mediaRetentionDaysFromEnv,
} from "../modules/media_retention.ts";

export type AnalysisState = "none" | "running" | "done" | "failed";

/** Pipeline stage order + weights (sum = 100). Documented for UI. */
export const ANALYSIS_STAGE_WEIGHTS = [
  { jobType: "probe_media", weight: 5, labelTr: "Medya kontrolü" },
  { jobType: "extract_audio_frames", weight: 15, labelTr: "Ses/kare çıkarımı" },
  { jobType: "transcribe", weight: 40, labelTr: "Ses çözülüyor (ASR)" },
  { jobType: "ocr_frames", weight: 20, labelTr: "OCR (yorum kareleri)" },
  { jobType: "segment_auction", weight: 10, labelTr: "Mezat olayları" },
  { jobType: "reconcile_sales", weight: 10, labelTr: "Satış birleştirme" },
] as const;

export type JobRow = {
  job_type: string;
  status: string;
  progress_percent?: number | null;
  stage?: string | null;
};

export function deriveAnalysisState(
  recordingStatus: string | null | undefined,
  jobs: Array<{ job_type?: string; status: string }>,
): AnalysisState {
  // Prefer active work over stale failures (re-queue / ordered pipeline).
  if (jobs.some((j) => j.status === "running" || j.status === "queued")) {
    return "running";
  }
  if (jobs.some((j) => j.status === "failed")) return "failed";
  // Cancelled = superseded/abandoned — never treat as analysis complete
  // (afra false "done" + 0/0 after remux-repair cancel wave).
  const byType = new Map(
    jobs
      .filter((j) => j.job_type)
      .map((j) => [String(j.job_type), j.status] as const),
  );
  const pipelineDone = ANALYSIS_STAGE_WEIGHTS.every(
    (s) => byType.get(s.jobType) === "succeeded",
  );
  if (pipelineDone) return "done";
  const st = String(recordingStatus ?? "");
  if (st === "complete") return "done";
  if (
    st === "transcribing" ||
    st === "analyzing" ||
    st === "extracting" ||
    st === "extracted"
  ) {
    return "running";
  }
  return "none";
}

/**
 * Weighted 0–100 pipeline progress from job rows.
 * succeeded → full weight; running → weight * job.progress/100; queued/failed → 0 contribution for that stage.
 */
export function deriveAnalysisProgress(jobs: JobRow[]): {
  analysisProgress: number;
  analysisStage: string | null;
} {
  if (!jobs.length) {
    return { analysisProgress: 0, analysisStage: null };
  }
  const byType = new Map(jobs.map((j) => [j.job_type, j]));
  let score = 0;
  let activeLabel: string | null = null;

  for (const stage of ANALYSIS_STAGE_WEIGHTS) {
    const j = byType.get(stage.jobType);
    if (!j) continue;
    if (j.status === "succeeded") {
      score += stage.weight;
      continue;
    }
    if (j.status === "cancelled") {
      // Superseded — no credit (must re-run for a real complete).
      if (!activeLabel) activeLabel = stage.labelTr;
      continue;
    }
    if (j.status === "running") {
      const p = Math.max(0, Math.min(100, Number(j.progress_percent ?? 0))) / 100;
      score += stage.weight * p;
      if (!activeLabel) activeLabel = stage.labelTr;
      continue;
    }
    if (j.status === "queued" || j.status === "failed") {
      if (!activeLabel) activeLabel = stage.labelTr;
      // no score yet
    }
  }

  const allDone = ANALYSIS_STAGE_WEIGHTS.every((s) => {
    const j = byType.get(s.jobType);
    return j && j.status === "succeeded";
  });
  if (allDone) {
    return { analysisProgress: 100, analysisStage: "Tamamlandı" };
  }

  const anyFailed = jobs.some((j) => j.status === "failed");
  if (anyFailed && !jobs.some((j) => j.status === "running" || j.status === "queued")) {
    return {
      analysisProgress: Math.round(Math.min(99, Math.max(0, score))),
      analysisStage: "Analiz başarısız",
    };
  }

  return {
    analysisProgress: Math.round(Math.min(99, Math.max(0, score))),
    analysisStage: activeLabel ?? "Analiz bekleniyor",
  };
}

async function statSize(abs: string): Promise<number> {
  try {
    const st = await stat(abs);
    return st.isFile() ? st.size : 0;
  } catch {
    return 0;
  }
}

/**
 * If DB size is 0/null but finalized MP4 (or .part) exists, return disk size
 * and optionally persist the heal.
 */
export async function resolveRecordingFileSize(
  env: AppEnv,
  sql: Sql,
  row: {
    id: string;
    storage_path: string;
    file_size_bytes?: number | string | null;
    capture_bytes?: number | string | null;
  },
  opts?: { persist?: boolean },
): Promise<number> {
  const dbSize = Number(row.file_size_bytes ?? row.capture_bytes ?? 0);
  let abs: string;
  try {
    abs = safeJoinStorage(env.storageRoot, row.storage_path);
  } catch {
    return Number.isFinite(dbSize) ? dbSize : 0;
  }
  const disk = await statSize(abs);
  const part = await statSize(`${abs}.part.mp4`);
  const best = Math.max(disk, part, Number.isFinite(dbSize) ? dbSize : 0);

  if (
    opts?.persist !== false &&
    best > 0 &&
    (!Number.isFinite(dbSize) || dbSize <= 0 || dbSize !== disk)
  ) {
    if (disk > 0 && (dbSize <= 0 || Math.abs(dbSize - disk) > 0)) {
      await sql`
        UPDATE recordings
        SET file_size_bytes = ${disk},
            capture_bytes = GREATEST(COALESCE(capture_bytes, 0), ${disk}),
            updated_at = now()
        WHERE id = ${row.id}
          AND (file_size_bytes IS NULL OR file_size_bytes = 0 OR file_size_bytes <> ${disk})
      `;
    }
  }

  return best;
}

export async function enrichRecordingRow(
  env: AppEnv,
  sql: Sql,
  row: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const id = String(row.id);
  const storagePath = String(row.storage_path ?? "");
  const fileSizeBytes = await resolveRecordingFileSize(
    env,
    sql,
    {
      id,
      storage_path: storagePath,
      file_size_bytes: row.file_size_bytes as number | string | null,
      capture_bytes: row.capture_bytes as number | string | null,
    },
    { persist: true },
  );

  // Latest row per stage — ignore superseded cancel waves from remux repair.
  const jobs = await sql<JobRow[]>`
    SELECT DISTINCT ON (job_type) job_type, status, progress_percent, stage
    FROM processing_jobs
    WHERE recording_id = ${id}
    ORDER BY job_type, created_at DESC
  `;
  const analysisState = deriveAnalysisState(
    row.status as string | null,
    jobs,
  );
  const { analysisProgress, analysisStage } = deriveAnalysisProgress(jobs);

  const liveCommentCount = Number(row.live_comment_count ?? 0);
  const commentCount = Number(row.comment_count ?? liveCommentCount);
  const captureStatus = String(row.capture_status ?? "");
  const isLive = String(row.source_type) === "live";
  // Prefer DB drought flag; for finished lives with 0 comments always surface.
  const commentsWarning =
    row.comments_warning != null && String(row.comments_warning).trim()
      ? String(row.comments_warning).trim()
      : isLive && captureStatus === "bitti" && liveCommentCount === 0
        ? "Yorum yok"
        : null;

  const mediaPurged = isMediaPurged(row);
  const retentionDays = mediaRetentionDaysFromEnv();

  return {
    ...row,
    file_size_bytes: fileSizeBytes,
    capture_bytes:
      fileSizeBytes > 0
        ? Math.max(Number(row.capture_bytes ?? 0), fileSizeBytes)
        : row.capture_bytes,
    analysisState,
    analysisProgress,
    analysisStage,
    liveCommentCount,
    commentCount,
    commentsWarning,
    commentsMissing: Boolean(commentsWarning),
    mediaPurged,
    mediaAvailable: !mediaPurged && fileSizeBytes >= 64_000,
    mediaPurgedAt: mediaPurged
      ? row.media_purged_at != null
        ? String(row.media_purged_at)
        : row.mediaPurgedAt != null
          ? String(row.mediaPurgedAt)
          : null
      : null,
    mediaPurgedNoteTr: mediaPurged ? mediaPurgedNoteTr(retentionDays) : null,
  };
}
