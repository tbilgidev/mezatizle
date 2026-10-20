import {
  createSql,
  claimNextJob,
  updateJobProgress,
  completeJob,
  failJob,
  reclaimStaleRunningJobs,
  reclaimAllRunningJobs,
} from "@mezatizle/db";
import { loadEnv } from "./lib/env.ts";
import { runProbeJob, runExtractJob } from "./modules/ingestion.ts";
import {
  segmentAuctionFromSignals,
  reconcileSales,
} from "./modules/auction_pipeline.ts";
import {
  transcribeMock,
  ocrFramesMock,
  tryPythonWorker,
} from "./modules/asr_ocr.ts";
import { assertUnderSpendLimit, recordApiUsage, recordMetric } from "./lib/cost.ts";

const env = loadEnv();
const sql = createSql(env.databaseUrl);
const workerId = process.env.WORKER_ID ?? `ts-worker-${process.pid}`;
const pollMs = Number(process.env.WORKER_POLL_INTERVAL_MS ?? "1500");
let lastStaleReclaimAt = 0;
let bootReclaimDone = false;

/** Keep lock fresh while long Python ASR/OCR runs so stale reclaim does not steal it. */
async function withJobHeartbeat<T>(
  jobId: string,
  progressPercent: number,
  stage: string,
  work: () => Promise<T>,
): Promise<T> {
  const touch = () =>
    updateJobProgress(sql, jobId, progressPercent, stage).catch((err) =>
      console.warn(`[worker] heartbeat failed job=${jobId}`, err),
    );
  const hb = setInterval(() => {
    void touch();
  }, 60_000);
  try {
    return await work();
  } finally {
    clearInterval(hb);
  }
}

const jobTypeFilter = (process.env.WORKER_JOB_TYPES ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/** Pipeline prerequisites — prevent segment/reconcile from racing ahead of ASR/OCR. */
async function prerequisitesMet(
  recordingId: string,
  jobType: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const need: Record<string, string[]> = {
    extract_audio_frames: ["probe_media"],
    transcribe: ["extract_audio_frames"],
    ocr_frames: ["extract_audio_frames"],
    segment_auction: ["transcribe"],
    reconcile_sales: ["segment_auction"],
  };
  const deps = need[jobType];
  if (!deps?.length) return { ok: true };
  for (const dep of deps) {
    const rows = await sql<{ status: string }[]>`
      SELECT status FROM processing_jobs
      WHERE recording_id = ${recordingId} AND job_type = ${dep}
      ORDER BY created_at DESC
      LIMIT 1
    `;
    const st = rows[0]?.status;
    if (st !== "succeeded" && st !== "cancelled") {
      return {
        ok: false,
        reason: `prerequisite ${dep} not succeeded (status=${st ?? "missing"})`,
      };
    }
  }
  return { ok: true };
}

async function processJob() {
  await assertUnderSpendLimit(sql, env.hardSpendLimitUsd);
  const job = await claimNextJob(
    sql,
    workerId,
    jobTypeFilter.length ? jobTypeFilter : undefined,
  );
  if (!job) return false;

  try {
    const prereq = await prerequisitesMet(job.recording_id, job.job_type);
    if (!prereq.ok) {
      // Put back on queue without burning an attempt budget forever.
      await sql`
        UPDATE processing_jobs
        SET status = 'queued',
            locked_by = NULL,
            locked_at = NULL,
            stage = 'waiting_prereq',
            attempts = GREATEST(attempts - 1, 0),
            available_at = now() + interval '20 seconds',
            error_message = ${prereq.reason},
            updated_at = now()
        WHERE id = ${job.id}
      `;
      return true;
    }

    await updateJobProgress(sql, job.id, 5, "started");
    let result: Record<string, unknown> = {};

    switch (job.job_type) {
      case "probe_media": {
        result = (await runProbeJob(
          sql,
          env,
          job.id,
          job.recording_id,
        )) as unknown as Record<string, unknown>;
        break;
      }
      case "extract_audio_frames": {
        await updateJobProgress(sql, job.id, 20, "ffmpeg");
        result = (await runExtractJob(
          sql,
          env,
          job.id,
          job.recording_id,
        )) as unknown as Record<string, unknown>;
        break;
      }
      case "transcribe": {
        await updateJobProgress(sql, job.id, 30, "asr");
        if (process.env.FORCE_MOCK_ASR === "1") {
          result = await transcribeMock(sql, env, job.recording_id);
        } else {
          const py = await withJobHeartbeat(job.id, 30, "asr", () =>
            tryPythonWorker("transcribe", job.recording_id, env),
          );
          if (!py.ok) {
            throw new Error(`ASR failed (faster-whisper): ${py.detail}`);
          }
          result = py as Record<string, unknown>;
          await recordApiUsage(sql, {
            provider: "local",
            operation: "asr_faster_whisper",
            units: Number(py.segments ?? 0),
            unitCostUsd: 0,
            recordingId: job.recording_id,
            meta: { backend: py.backend, model: py.model ?? null },
          });
          await recordMetric(sql, {
            name: "asr_segments",
            value: Number(py.segments ?? 0),
            unit: "count",
            recordingId: job.recording_id,
            jobId: job.id,
            labels: { backend: String(py.backend ?? "") },
          });
        }
        break;
      }
      case "ocr_frames": {
        await updateJobProgress(sql, job.id, 40, "ocr");
        if (process.env.FORCE_MOCK_OCR === "1") {
          result = await ocrFramesMock(sql, env, job.recording_id);
        } else {
          const py = await withJobHeartbeat(job.id, 40, "ocr", () =>
            tryPythonWorker("ocr", job.recording_id, env),
          );
          if (!py.ok) {
            throw new Error(`OCR failed: ${py.detail}`);
          }
          result = py as Record<string, unknown>;
          await recordApiUsage(sql, {
            provider: "local",
            operation: "ocr_local",
            units: Number(py.texts ?? py.frames ?? 0),
            unitCostUsd: 0,
            recordingId: job.recording_id,
            meta: { backend: py.backend, crop: py.crop ?? null },
          });
          await recordMetric(sql, {
            name: "ocr_texts",
            value: Number(py.texts ?? 0),
            unit: "count",
            recordingId: job.recording_id,
            jobId: job.id,
            labels: { backend: String(py.backend ?? "") },
          });
        }
        break;
      }
      case "segment_auction": {
        await updateJobProgress(sql, job.id, 60, "segment");
        await sql`
          UPDATE recordings SET status = 'analyzing', updated_at = now()
          WHERE id = ${job.recording_id}
        `;
        result = await segmentAuctionFromSignals(sql, job.recording_id);
        await recordMetric(sql, {
          name: "auction_events",
          value: Number((result as { eventsCreated?: number }).eventsCreated ?? 0),
          unit: "count",
          recordingId: job.recording_id,
          jobId: job.id,
        });
        break;
      }
      case "reconcile_sales": {
        await updateJobProgress(sql, job.id, 80, "reconcile");
        result = await reconcileSales(sql, job.recording_id, env.storageRoot);
        await recordMetric(sql, {
          name: "sales_created",
          value: Number((result as { salesCreated?: number }).salesCreated ?? 0),
          unit: "count",
          recordingId: job.recording_id,
          jobId: job.id,
        });
        break;
      }
      default:
        throw new Error(`Unknown job type: ${job.job_type}`);
    }

    await completeJob(sql, job.id, result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await failJob(sql, job.id, msg);
    const terminal = await sql<{ status: string }[]>`
      SELECT status FROM processing_jobs WHERE id = ${job.id}
    `;
    // Only mark recording failed when the job is permanently failed (not retrying).
    if (terminal[0]?.status === "failed") {
      await sql`
        UPDATE recordings SET status = 'failed', error_message = ${msg}, updated_at = now()
        WHERE id = ${job.recording_id}
          AND status NOT IN ('complete')
      `;
    }
  }
  return true;
}

async function maybeReclaimStale() {
  const now = Date.now();
  // On boot and every ~2 minutes
  if (lastStaleReclaimAt && now - lastStaleReclaimAt < 120_000) return;
  lastStaleReclaimAt = now;
  try {
    const n = await reclaimStaleRunningJobs(sql);
    if (n > 0) {
      console.warn(`[worker] reclaimed ${n} stale running job(s)`);
    }
  } catch (err) {
    console.error("[worker] stale reclaim failed", err);
  }
}

export async function workerLoop(maxIdleRounds = Infinity) {
  let idle = 0;
  // Secondary drain workers must not steal healthy in-flight ASR/OCR locks.
  if (!bootReclaimDone) {
    bootReclaimDone = true;
    if (process.env.SKIP_BOOT_RECLAIM === "1") {
      console.warn(`[worker] ${workerId} skip boot reclaim (SKIP_BOOT_RECLAIM=1)`);
    } else {
      try {
        const n = await reclaimAllRunningJobs(sql);
        if (n > 0) {
          console.warn(`[worker] boot-reclaimed ${n} running job(s)`);
        }
      } catch (err) {
        console.error("[worker] boot reclaim failed", err);
      }
    }
  }
  await maybeReclaimStale();
  // Stale reclaim must run even while processJob awaits long Python work.
  const reclaimTimer = setInterval(() => {
    void maybeReclaimStale();
  }, 120_000);
  try {
    while (idle < maxIdleRounds) {
      await maybeReclaimStale();
      const did = await processJob();
      if (!did) {
        idle++;
        await Bun.sleep(pollMs);
      } else {
        idle = 0;
      }
    }
  } finally {
    clearInterval(reclaimTimer);
  }
}

if (import.meta.main) {
  console.log(`[worker] ${workerId} profile=${env.profile.profile}`);
  workerLoop().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
