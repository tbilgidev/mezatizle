import {
  createSql,
  claimNextJob,
  updateJobProgress,
  completeJob,
  failJob,
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
import { assertUnderSpendLimit } from "./lib/cost.ts";

const env = loadEnv();
const sql = createSql(env.databaseUrl);
const workerId = process.env.WORKER_ID ?? `ts-worker-${process.pid}`;
const pollMs = Number(process.env.WORKER_POLL_INTERVAL_MS ?? "1500");

async function processJob() {
  await assertUnderSpendLimit(sql, env.hardSpendLimitUsd);
  const job = await claimNextJob(sql, workerId);
  if (!job) return false;

  try {
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
          const py = await tryPythonWorker("transcribe", job.recording_id, env);
          result = py.ok
            ? (py as Record<string, unknown>)
            : await transcribeMock(sql, env, job.recording_id);
          if (!py.ok) result = { ...result, pythonError: py.detail };
        }
        break;
      }
      case "ocr_frames": {
        await updateJobProgress(sql, job.id, 40, "ocr");
        if (process.env.FORCE_MOCK_OCR === "1") {
          result = await ocrFramesMock(sql, env, job.recording_id);
        } else {
          const py = await tryPythonWorker("ocr", job.recording_id, env);
          result = py.ok
            ? (py as Record<string, unknown>)
            : await ocrFramesMock(sql, env, job.recording_id);
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
        break;
      }
      case "reconcile_sales": {
        await updateJobProgress(sql, job.id, 80, "reconcile");
        result = await reconcileSales(sql, job.recording_id);
        break;
      }
      default:
        throw new Error(`Unknown job type: ${job.job_type}`);
    }

    await completeJob(sql, job.id, result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await failJob(sql, job.id, msg);
    await sql`
      UPDATE recordings SET status = 'failed', error_message = ${msg}, updated_at = now()
      WHERE id = ${job.recording_id}
        AND status NOT IN ('complete')
    `;
  }
  return true;
}

export async function workerLoop(maxIdleRounds = Infinity) {
  let idle = 0;
  while (idle < maxIdleRounds) {
    const did = await processJob();
    if (!did) {
      idle++;
      await Bun.sleep(pollMs);
    } else {
      idle = 0;
    }
  }
}

if (import.meta.main) {
  console.log(`[worker] ${workerId} profile=${env.profile.profile}`);
  workerLoop().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
