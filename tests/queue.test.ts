import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import {
  createSql,
  migrate,
  enqueueJob,
  claimNextJob,
  updateJobProgress,
  completeJob,
} from "@mezatizle/db";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgres://mezatizle:mezatizle@127.0.0.1:5432/mezatizle";

describe("postgres queue", () => {
  const sql = createSql(DATABASE_URL);
  let recordingId = "";

  beforeAll(async () => {
    await migrate(DATABASE_URL);
    const seller = await sql<{ id: string }[]>`
      INSERT INTO sellers (instagram_username)
      VALUES (${`queue_test_${Date.now()}`})
      RETURNING id
    `;
    const rec = await sql<{ id: string }[]>`
      INSERT INTO recordings (
        seller_id, original_filename, storage_path, recorded_at, status, file_size_bytes
      ) VALUES (
        ${seller[0]!.id}, 't.mp4', ${`recordings/t-${Date.now()}.mp4`}, now(), 'uploaded', 1
      )
      RETURNING id
    `;
    recordingId = rec[0]!.id;
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  test("claim SKIP LOCKED and complete", async () => {
    const jobId = await enqueueJob(sql, recordingId, "probe_media", 1);
    const claimed = await claimNextJob(sql, "test-worker", ["probe_media"]);
    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe(jobId);
    expect(claimed!.status).toBe("running");
    await updateJobProgress(sql, jobId, 50, "halfway");
    await completeJob(sql, jobId, { ok: true });
    const rows = await sql<{ status: string; progress_percent: number }[]>`
      SELECT status, progress_percent FROM processing_jobs WHERE id = ${jobId}
    `;
    expect(rows[0]!.status).toBe("succeeded");
    expect(rows[0]!.progress_percent).toBe(100);
  });
});
