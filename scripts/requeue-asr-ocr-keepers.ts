/**
 * Re-queue ASR → OCR → segment → reconcile for yesilkoy keepers.
 * Assumes extract already succeeded; does not re-probe/re-extract.
 *
 * Usage: bun run scripts/requeue-asr-ocr-keepers.ts
 */
import { createSql } from "@mezatizle/db";

const KEEPERS = [
  "6c7e9508-5162-4d9f-955d-d12c6fa195bc",
  "99b0f63c-94d7-4a63-a746-257bb5589a8e",
];

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://mezatizle:mezatizle@127.0.0.1:5433/mezatizle";

const sql = createSql(databaseUrl);

async function enqueue(
  recordingId: string,
  jobType: string,
  priority: number,
) {
  await sql`
    INSERT INTO processing_jobs (recording_id, job_type, status, priority, progress_percent, stage)
    VALUES (${recordingId}, ${jobType}, 'queued', ${priority}, 0, 'queued')
  `;
}

for (const id of KEEPERS) {
  const [rec] = await sql<{ original_filename: string; status: string }[]>`
    SELECT original_filename, status FROM recordings WHERE id = ${id}
  `;
  if (!rec) {
    console.error("missing", id);
    continue;
  }
  console.log("requeue ASR/OCR/segment/reconcile", id, rec.original_filename);

  // Clear failed/stale analysis jobs for these stages (keep probe/extract history)
  await sql`
    DELETE FROM processing_jobs
    WHERE recording_id = ${id}
      AND job_type IN ('transcribe', 'ocr_frames', 'segment_auction', 'reconcile_sales')
  `;
  await sql`DELETE FROM sale_evidence WHERE sale_id IN (SELECT id FROM sales WHERE recording_id = ${id})`;
  const products = await sql<{ product_id: string | null }[]>`
    SELECT product_id FROM sales WHERE recording_id = ${id}
  `;
  await sql`DELETE FROM sales WHERE recording_id = ${id}`;
  const pids = products
    .map((p) => p.product_id)
    .filter((x): x is string => Boolean(x));
  if (pids.length) {
    await sql`DELETE FROM products WHERE id = ANY(${pids}::uuid[])`;
  }
  await sql`DELETE FROM auction_events WHERE recording_id = ${id}`;
  await sql`DELETE FROM observed_comments WHERE recording_id = ${id}`;
  await sql`DELETE FROM transcript_segments WHERE recording_id = ${id}`;

  await sql`
    UPDATE recordings
    SET status = 'extracted', error_message = NULL, updated_at = now()
    WHERE id = ${id}
  `;

  await enqueue(id, "transcribe", 30);
  await enqueue(id, "ocr_frames", 40);
  await enqueue(id, "segment_auction", 50);
  await enqueue(id, "reconcile_sales", 60);
  console.log("enqueued", id);
}

await sql.end?.({ timeout: 5 });
console.log("done — worker will process (whisper small ≈3× realtime)");
process.exit(0);
