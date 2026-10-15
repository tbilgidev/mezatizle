/**
 * Wipe derived analysis for yesilkoy keepers (keep MP4 + recording rows),
 * then enqueue full pipeline: probe → extract → transcribe → ocr → segment → reconcile.
 *
 * Usage: bun run scripts/wipe-and-reanalyze-keepers.ts
 */
import { createSql } from "@mezatizle/db";
import { enqueueAnalysisPipeline } from "../apps/api/src/modules/ingestion.ts";

const KEEPERS = [
  "6c7e9508-5162-4d9f-955d-d12c6fa195bc",
  "99b0f63c-94d7-4a63-a746-257bb5589a8e",
];

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://mezatizle:mezatizle@127.0.0.1:5433/mezatizle";

const sql = createSql(databaseUrl);

for (const id of KEEPERS) {
  const [rec] = await sql<{ original_filename: string; storage_path: string }[]>`
    SELECT original_filename, storage_path FROM recordings WHERE id = ${id}
  `;
  if (!rec) {
    console.error("missing", id);
    continue;
  }
  console.log("wipe", id, rec.original_filename, "keep file", rec.storage_path);

  // Derived only — never touch recordings row identity / live_captures / secrets
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
  await sql`DELETE FROM processing_metrics WHERE recording_id = ${id}`;
  await sql`DELETE FROM processing_jobs WHERE recording_id = ${id}`;

  await sql`
    UPDATE recordings
    SET status = 'uploaded', error_message = NULL, updated_at = now()
    WHERE id = ${id}
  `;

  await enqueueAnalysisPipeline(sql, id);
  console.log("enqueued full pipeline", id);
}

await sql.end?.({ timeout: 5 });
console.log("done — worker will process jobs");
process.exit(0);
