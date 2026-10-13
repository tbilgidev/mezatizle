import type { Sql } from "./client.ts";

export type ClaimedJob = {
  id: string;
  recording_id: string;
  job_type: string;
  status: string;
  progress_percent: number;
  stage: string | null;
  attempts: number;
  max_attempts: number;
};

/** Claim next queued job with SKIP LOCKED (PostgreSQL-backed queue). */
export async function claimNextJob(
  sql: Sql,
  workerId: string,
  jobTypes?: string[],
): Promise<ClaimedJob | null> {
  const rows = await sql.begin(async (tx) => {
    const candidates = jobTypes?.length
      ? await tx<ClaimedJob[]>`
          SELECT id, recording_id, job_type, status, progress_percent, stage, attempts, max_attempts
          FROM processing_jobs
          WHERE status = 'queued'
            AND available_at <= now()
            AND job_type = ANY(${jobTypes})
          ORDER BY priority ASC, created_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        `
      : await tx<ClaimedJob[]>`
          SELECT id, recording_id, job_type, status, progress_percent, stage, attempts, max_attempts
          FROM processing_jobs
          WHERE status = 'queued'
            AND available_at <= now()
          ORDER BY priority ASC, created_at ASC
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        `;
    if (!candidates.length) return [] as ClaimedJob[];
    const job = candidates[0]!;
    const updated = await tx<ClaimedJob[]>`
      UPDATE processing_jobs
      SET status = 'running',
          locked_by = ${workerId},
          locked_at = now(),
          started_at = COALESCE(started_at, now()),
          attempts = attempts + 1,
          updated_at = now(),
          stage = COALESCE(stage, 'claimed')
      WHERE id = ${job.id}
      RETURNING id, recording_id, job_type, status, progress_percent, stage, attempts, max_attempts
    `;
    return updated;
  });
  return rows[0] ?? null;
}

export async function updateJobProgress(
  sql: Sql,
  jobId: string,
  progressPercent: number,
  stage?: string,
) {
  await sql`
    UPDATE processing_jobs
    SET progress_percent = ${Math.max(0, Math.min(100, progressPercent))},
        stage = COALESCE(${stage ?? null}, stage),
        updated_at = now()
    WHERE id = ${jobId}
  `;
}

export async function completeJob(
  sql: Sql,
  jobId: string,
  result: Record<string, unknown> = {},
) {
  await sql`
    UPDATE processing_jobs
    SET status = 'succeeded',
        progress_percent = 100,
        stage = 'done',
        finished_at = now(),
        result_json = ${sql.json(result)},
        locked_by = NULL,
        updated_at = now()
    WHERE id = ${jobId}
  `;
}

export async function failJob(sql: Sql, jobId: string, errorMessage: string) {
  await sql`
    UPDATE processing_jobs
    SET status = CASE
          WHEN attempts >= max_attempts THEN 'failed'
          ELSE 'queued'
        END,
        error_message = ${errorMessage},
        available_at = CASE
          WHEN attempts >= max_attempts THEN available_at
          ELSE now() + interval '15 seconds'
        END,
        finished_at = CASE
          WHEN attempts >= max_attempts THEN now()
          ELSE NULL
        END,
        locked_by = NULL,
        locked_at = NULL,
        stage = CASE
          WHEN attempts >= max_attempts THEN 'failed'
          ELSE 'retry_scheduled'
        END,
        updated_at = now()
    WHERE id = ${jobId}
  `;
}

export async function enqueueJob(
  sql: Sql,
  recordingId: string,
  jobType: string,
  priority = 100,
) {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO processing_jobs (recording_id, job_type, status, priority)
    VALUES (${recordingId}, ${jobType}, 'queued', ${priority})
    RETURNING id
  `;
  return rows[0]!.id;
}
