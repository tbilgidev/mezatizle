/**
 * Re-queue full analysis for afra (or any recording) after pipeline fixes.
 * Cancels superseded non-terminal jobs; keeps live_api comments.
 *
 * Usage: bun run scripts/rerun-afra-analysis.ts [recording-id]
 */
import { createSql, enqueueJob } from "@mezatizle/db";

const RECORDING_ID =
  process.argv[2] ?? "69765459-23ff-4e0c-a8ce-aaa992b2c281";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://mezatizle:mezatizle@127.0.0.1:5433/mezatizle";

const sql = createSql(databaseUrl);

const [rec] = await sql<
  {
    original_filename: string;
    status: string;
    duration_seconds: number | null;
    capture_status: string | null;
  }[]
>`
  SELECT original_filename, status, duration_seconds, capture_status
  FROM recordings WHERE id = ${RECORDING_ID}
`;
if (!rec) {
  console.error("missing recording", RECORDING_ID);
  process.exit(1);
}
console.log(
  "===",
  RECORDING_ID,
  rec.original_filename,
  "status=",
  rec.status,
  "capture=",
  rec.capture_status,
  "dur=",
  rec.duration_seconds,
);

const [counts] = await sql<
  { comments: string; transcript: string; events: string; sales: string }[]
>`
  SELECT
    (SELECT COUNT(*)::text FROM observed_comments WHERE recording_id = ${RECORDING_ID}) AS comments,
    (SELECT COUNT(*)::text FROM transcript_segments WHERE recording_id = ${RECORDING_ID}) AS transcript,
    (SELECT COUNT(*)::text FROM auction_events WHERE recording_id = ${RECORDING_ID}) AS events,
    (SELECT COUNT(*)::text FROM sales WHERE recording_id = ${RECORDING_ID}) AS sales
`;
console.log("before", counts);

const cancelled = await sql<{ id: string }[]>`
  UPDATE processing_jobs
  SET status = 'cancelled',
      error_message = COALESCE(error_message, '') || ' | superseded for afra rebuild',
      locked_by = NULL,
      locked_at = NULL,
      finished_at = COALESCE(finished_at, now()),
      updated_at = now()
  WHERE recording_id = ${RECORDING_ID}
    AND status IN ('queued', 'running', 'failed')
  RETURNING id
`;
console.log("cancelled jobs", cancelled.length);

await sql`DELETE FROM transcript_segments WHERE recording_id = ${RECORDING_ID}`;
await sql`DELETE FROM auction_events WHERE recording_id = ${RECORDING_ID}`;
await sql`
  DELETE FROM sale_evidence
  WHERE sale_id IN (SELECT id FROM sales WHERE recording_id = ${RECORDING_ID})
`;
await sql`DELETE FROM sales WHERE recording_id = ${RECORDING_ID}`;

await sql`
  UPDATE recordings
  SET status = 'ready',
      error_message = NULL,
      updated_at = now()
  WHERE id = ${RECORDING_ID}
`;

const stages: Array<[string, number]> = [
  ["probe_media", 10],
  ["extract_audio_frames", 20],
  ["transcribe", 30],
  ["ocr_frames", 40],
  ["segment_auction", 50],
  ["reconcile_sales", 60],
];
for (const [jobType, priority] of stages) {
  const id = await enqueueJob(sql, RECORDING_ID, jobType, priority);
  console.log("enqueued", jobType, id);
}

const [afterComments] = await sql<{ n: string }[]>`
  SELECT COUNT(*)::text AS n FROM observed_comments WHERE recording_id = ${RECORDING_ID}
`;
console.log("comments preserved", afterComments?.n);
await sql.end({ timeout: 5 });
console.log("done — drain worker will pick up extract→ASR→OCR→segment→reconcile");
