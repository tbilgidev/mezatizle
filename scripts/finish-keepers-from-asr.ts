/**
 * Finish analysis from existing ASR (skip long DASH OCR).
 * Usage:
 *   bun run scripts/finish-keepers-from-asr.ts              # 6c7e only
 *   bun run scripts/finish-keepers-from-asr.ts --with-asr-99b0
 */
import { createSql } from "@mezatizle/db";
import { loadEnv } from "../apps/api/src/lib/env.ts";
import { tryPythonWorker } from "../apps/api/src/modules/asr_ocr.ts";
import {
  segmentAuctionFromSignals,
  reconcileSales,
} from "../apps/api/src/modules/auction_pipeline.ts";

const ID_6C = "6c7e9508-5162-4d9f-955d-d12c6fa195bc";
const ID_99 = "99b0f63c-94d7-4a63-a746-257bb5589a8e";
const withAsr99 = process.argv.includes("--with-asr-99b0");

const env = loadEnv();
const sql = createSql(env.databaseUrl);

async function setJob(
  id: string,
  type: string,
  status: string,
  progress: number,
  stage: string,
  err: string | null = null,
) {
  const done =
    status === "succeeded" || status === "failed" || status === "cancelled";
  await sql`
    UPDATE processing_jobs SET
      status = ${status},
      progress_percent = ${progress},
      stage = ${stage},
      error_message = ${err},
      locked_by = NULL,
      locked_at = NULL,
      finished_at = ${done ? new Date() : null},
      updated_at = now()
    WHERE recording_id = ${id} AND job_type = ${type}
  `;
}

async function ensureJobs(id: string) {
  for (const [jt, pri] of [
    ["transcribe", 30],
    ["ocr_frames", 40],
    ["segment_auction", 50],
    ["reconcile_sales", 60],
  ] as const) {
    const [ex] = await sql`
      SELECT id FROM processing_jobs
      WHERE recording_id = ${id} AND job_type = ${jt} LIMIT 1
    `;
    if (!ex) {
      await sql`
        INSERT INTO processing_jobs
          (recording_id, job_type, status, priority, progress_percent, stage)
        VALUES (${id}, ${jt}, 'queued', ${pri}, 0, 'queued')
      `;
    }
  }
}

async function counts(id: string) {
  const [c] = await sql<{
    tx: string;
    comments: string;
    events: string;
    sales: string;
  }[]>`
    SELECT
      (SELECT COUNT(*)::text FROM transcript_segments WHERE recording_id = ${id}) AS tx,
      (SELECT COUNT(*)::text FROM observed_comments WHERE recording_id = ${id}) AS comments,
      (SELECT COUNT(*)::text FROM auction_events WHERE recording_id = ${id}) AS events,
      (SELECT COUNT(*)::text FROM sales WHERE recording_id = ${id}) AS sales
  `;
  return c;
}

async function finishOne(id: string, opts: { runAsr: boolean }) {
  await ensureJobs(id);
  console.log(`\n=== ${id} runAsr=${opts.runAsr} ===`);
  console.log("before", await counts(id));

  if (opts.runAsr) {
    await setJob(id, "transcribe", "running", 20, "asr");
    const asr = await tryPythonWorker("transcribe", id, env);
    console.log("ASR", JSON.stringify(asr));
    if (!asr.ok) {
      await setJob(id, "transcribe", "failed", 0, "failed", String(asr.detail));
      throw new Error(`ASR failed: ${asr.detail}`);
    }
    await setJob(id, "transcribe", "succeeded", 100, "done");
  } else {
    await setJob(id, "transcribe", "succeeded", 100, "done");
  }

  // DASH masters have no comment overlay — skip long OCR; mark best-effort done.
  await setJob(
    id,
    "ocr_frames",
    "succeeded",
    100,
    "done",
    "skipped_dash_blind_fast_path",
  );

  await setJob(id, "segment_auction", "running", 40, "segment");
  const seg = await segmentAuctionFromSignals(sql, id);
  console.log("segment", JSON.stringify(seg));
  await setJob(id, "segment_auction", "succeeded", 100, "done");

  await setJob(id, "reconcile_sales", "running", 40, "reconcile");
  const rec = await reconcileSales(sql, id, env.storageRoot);
  console.log("reconcile", JSON.stringify(rec));
  await setJob(id, "reconcile_sales", "succeeded", 100, "done");

  await sql`
    UPDATE recordings
    SET status = 'complete', error_message = NULL, updated_at = now()
    WHERE id = ${id}
  `;
  console.log("after", await counts(id));
}

console.log(
  `[finish] PYTHON_BIN=${process.env.PYTHON_BIN} WHISPER=${process.env.WHISPER_MODEL}`,
);

await finishOne(ID_6C, { runAsr: false });
if (withAsr99) {
  await finishOne(ID_99, { runAsr: true });
} else {
  console.log("skip 99b0 (pass --with-asr-99b0 to re-ASR)");
}

await sql.end?.({ timeout: 5 });
console.log("FINISH_OK");
process.exit(0);
