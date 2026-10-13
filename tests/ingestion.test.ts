import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { join } from "node:path";
import { createSql, migrate, claimNextJob, completeJob } from "@mezatizle/db";
import { loadEnv } from "../apps/api/src/lib/env.ts";
import { ensureStorageDirs } from "../apps/api/src/lib/storage.ts";
import {
  createRecordingFromUpload,
  runProbeJob,
  runExtractJob,
} from "../apps/api/src/modules/ingestion.ts";
import { transcribeMock } from "../apps/api/src/modules/asr_ocr.ts";
import {
  segmentAuctionFromSignals,
  reconcileSales,
} from "../apps/api/src/modules/auction_pipeline.ts";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgres://mezatizle:mezatizle@127.0.0.1:5432/mezatizle";

describe("ingestion + pipeline", () => {
  const env = loadEnv();
  env.databaseUrl = DATABASE_URL;
  process.env.FORCE_MOCK_ASR = "1";
  process.env.FORCE_MOCK_OCR = "1";
  const sql = createSql(DATABASE_URL);

  beforeAll(async () => {
    await migrate(DATABASE_URL);
    await ensureStorageDirs(env.storageRoot);
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  test("upload probe extract segment reconcile", async () => {
    const fixture = join(import.meta.dir, "../fixtures/sample-live.mp4");
    const file = Bun.file(fixture);
    expect(await file.exists()).toBe(true);
    const upload = new File(
      [await file.arrayBuffer()],
      "sample-live.mp4",
      { type: "video/mp4" },
    );
    const created = await createRecordingFromUpload(sql, env, {
      file: upload,
      sellerInstagramUsername: `seller_${Date.now()}`,
      recordedAt: new Date().toISOString(),
      notes: "test",
    });
    expect(created.recordingId).toBeTruthy();

    const probe = await claimNextJob(sql, "test", ["probe_media"]);
    expect(probe).not.toBeNull();
    const probeResult = await runProbeJob(
      sql,
      env,
      probe!.id,
      created.recordingId,
    );
    expect(probeResult.durationSeconds).toBeGreaterThan(0);
    expect(probeResult.width).toBeGreaterThan(0);
    await completeJob(sql, probe!.id, probeResult as unknown as Record<string, unknown>);

    const extract = await claimNextJob(sql, "test", ["extract_audio_frames"]);
    expect(extract).not.toBeNull();
    const extractResult = await runExtractJob(
      sql,
      env,
      extract!.id,
      created.recordingId,
    );
    expect(extractResult.frameCount).toBeGreaterThan(0);
    await completeJob(
      sql,
      extract!.id,
      extractResult as unknown as Record<string, unknown>,
    );

    const asr = await transcribeMock(sql, env, created.recordingId);
    expect(asr.segments).toBeGreaterThan(0);

    const seg = await segmentAuctionFromSignals(sql, created.recordingId);
    expect(seg.eventsCreated).toBeGreaterThan(0);

    const sales = await reconcileSales(sql, created.recordingId);
    expect(sales.salesCreated).toBeGreaterThan(0);

    const rec = await sql<{ status: string }[]>`
      SELECT status FROM recordings WHERE id = ${created.recordingId}
    `;
    expect(rec[0]!.status).toBe("complete");
  }, 60_000);

  test("rejects path traversal filename", async () => {
    const evil = new File([new Uint8Array([0, 0, 0])], "../evil.mp4", {
      type: "video/mp4",
    });
    await expect(
      createRecordingFromUpload(sql, env, {
        file: evil,
        sellerInstagramUsername: "ok_user",
        recordedAt: new Date().toISOString(),
      }),
    ).rejects.toThrow();
  });
});
