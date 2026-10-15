/**
 * Enrich recording rows for API/UI: real on-disk size + analysisState.
 */
import { stat } from "node:fs/promises";
import type { Sql } from "@mezatizle/db";
import type { AppEnv } from "./env.ts";
import { safeJoinStorage } from "./storage.ts";

export type AnalysisState = "none" | "running" | "done" | "failed";

export function deriveAnalysisState(
  recordingStatus: string | null | undefined,
  jobs: Array<{ status: string }>,
): AnalysisState {
  if (jobs.some((j) => j.status === "failed")) return "failed";
  if (jobs.some((j) => j.status === "running" || j.status === "queued")) {
    return "running";
  }
  if (
    jobs.length > 0 &&
    jobs.every((j) => j.status === "succeeded" || j.status === "cancelled")
  ) {
    return "done";
  }
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
    // Only heal upward / from zero — don't shrink a larger DB value unless disk is authoritative final
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

  const jobs = await sql<{ status: string }[]>`
    SELECT status FROM processing_jobs WHERE recording_id = ${id}
  `;
  const analysisState = deriveAnalysisState(
    row.status as string | null,
    jobs,
  );

  return {
    ...row,
    file_size_bytes: fileSizeBytes,
    capture_bytes:
      fileSizeBytes > 0
        ? Math.max(Number(row.capture_bytes ?? 0), fileSizeBytes)
        : row.capture_bytes,
    analysisState,
  };
}
