/**
 * Ordered end-to-end analysis for keeper recordings (no job-queue races).
 * Assumes probe+extract already done (WAV + frames present).
 *
 * Usage: bun run scripts/run-keeper-pipeline-ordered.ts [recordingId...]
 */
import { createSql } from "@mezatizle/db";
import { loadEnv } from "../apps/api/src/lib/env.ts";
import { tryPythonWorker } from "../apps/api/src/modules/asr_ocr.ts";
import {
  segmentAuctionFromSignals,
  reconcileSales,
} from "../apps/api/src/modules/auction_pipeline.ts";

const DEFAULT_KEEPERS = [
  "6c7e9508-5162-4d9f-955d-d12c6fa195bc",
  "99b0f63c-94d7-4a63-a746-257bb5589a8e",
];

const ids = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const keepers = ids.length ? ids : DEFAULT_KEEPERS;

const env = loadEnv();
const sql = createSql(env.databaseUrl);

console.log(
  `[pipeline] PYTHON_BIN=${process.env.PYTHON_BIN ?? "(unset)"} WHISPER_MODEL=${process.env.WHISPER_MODEL ?? "(default)"} OCR_CROP=${process.env.OCR_CROP_FRAC ?? "(default)"}`,
);

for (const id of keepers) {
  const [rec] = await sql<{ original_filename: string }[]>`
    SELECT original_filename FROM recordings WHERE id = ${id}
  `;
  if (!rec) {
    console.error("[pipeline] missing", id);
    continue;
  }
  console.log(`\n=== ${id} ${rec.original_filename} ===`);

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

  const t0 = performance.now();
  console.log("[1/4] transcribe…");
  const asr = await tryPythonWorker("transcribe", id, env);
  console.log("[1/4] ASR", JSON.stringify(asr));
  if (!asr.ok) {
    console.error("[pipeline] ASR failed — aborting this recording");
    await sql`
      UPDATE recordings SET status = 'failed', error_message = ${String(asr.detail)}, updated_at = now()
      WHERE id = ${id}
    `;
    continue;
  }

  console.log("[2/4] ocr…");
  const ocr = await tryPythonWorker("ocr", id, env);
  console.log("[2/4] OCR", JSON.stringify(ocr));
  if (!ocr.ok) {
    console.warn("[pipeline] OCR failed (continuing with ASR-only):", ocr.detail);
  }

  console.log("[3/4] segment…");
  const seg = await segmentAuctionFromSignals(sql, id);
  console.log("[3/4] segment", JSON.stringify(seg));

  console.log("[4/4] reconcile…");
  const recResult = await reconcileSales(sql, id, env.storageRoot);
  console.log("[4/4] reconcile", JSON.stringify(recResult));

  await sql`
    UPDATE recordings SET status = 'complete', error_message = NULL, updated_at = now()
    WHERE id = ${id}
  `;

  const [counts] = await sql<
    {
      transcripts: string;
      comments: string;
      events: string;
      sales: string;
    }[]
  >`
    SELECT
      (SELECT COUNT(*)::text FROM transcript_segments WHERE recording_id = ${id}) AS transcripts,
      (SELECT COUNT(*)::text FROM observed_comments WHERE recording_id = ${id}) AS comments,
      (SELECT COUNT(*)::text FROM auction_events WHERE recording_id = ${id}) AS events,
      (SELECT COUNT(*)::text FROM sales WHERE recording_id = ${id}) AS sales
  `;
  console.log(
    `[pipeline] done ${id} in ${((performance.now() - t0) / 1000).toFixed(1)}s`,
    counts,
  );
}

await sql.end?.({ timeout: 5 });
console.log("\n[pipeline] all keepers finished");
process.exit(0);
