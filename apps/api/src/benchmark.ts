/**
 * Synthetic benchmark — measures local pipeline timings on fixtures/sample-live.mp4.
 * Never invents numbers: only writes measured results.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createSql, migrate, enqueueJob, claimNextJob, completeJob } from "@mezatizle/db";
import { loadEnv } from "./lib/env.ts";
import { ensureStorageDirs, safeJoinStorage } from "./lib/storage.ts";
import { runProbeJob, runExtractJob, upsertSeller } from "./modules/ingestion.ts";
import { transcribeMock, ocrFramesMock } from "./modules/asr_ocr.ts";
import {
  segmentAuctionFromSignals,
  reconcileSales,
} from "./modules/auction_pipeline.ts";

const env = loadEnv();
await ensureStorageDirs(env.storageRoot);
await migrate(env.databaseUrl);
const sql = createSql(env.databaseUrl);

const fixture = join(import.meta.dir, "../../../fixtures/sample-live.mp4");
const fixtureFile = Bun.file(fixture);
if (!(await fixtureFile.exists())) {
  console.error("Missing fixtures/sample-live.mp4");
  process.exit(1);
}

const seller = await upsertSeller(sql, "benchmark_seller");
const id = crypto.randomUUID();
const dest = safeJoinStorage(env.storageRoot, "recordings", `${id}.mp4`);
await mkdir(join(env.storageRoot, "recordings"), { recursive: true });
await Bun.write(dest, fixtureFile);

await sql`
  INSERT INTO recordings (id, seller_id, original_filename, storage_path, recorded_at, status, file_size_bytes)
  VALUES (${id}, ${seller.id}, ${"sample-live.mp4"}, ${`recordings/${id}.mp4`}, now(), 'uploaded', ${fixtureFile.size})
`;

const timings: Record<string, number> = {};
async function timed<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  const out = await fn();
  timings[name] = Math.round(performance.now() - t0);
  return out;
}

const probeJob = await enqueueJob(sql, id, "probe_media", 10);
const extractJob = await enqueueJob(sql, id, "extract_audio_frames", 20);

await timed("probe_ms", async () => {
  const j = await claimNextJob(sql, "benchmark", ["probe_media"]);
  if (!j) throw new Error("no probe job");
  const r = await runProbeJob(sql, env, j.id, id);
  await completeJob(sql, j.id, r as unknown as Record<string, unknown>);
  return r;
});

await timed("extract_ms", async () => {
  const j = await claimNextJob(sql, "benchmark", ["extract_audio_frames"]);
  if (!j) throw new Error("no extract job");
  const r = await runExtractJob(sql, env, j.id, id);
  await completeJob(sql, j.id, r as unknown as Record<string, unknown>);
  return r;
});

await timed("asr_mock_ms", () => transcribeMock(sql, env, id));
await timed("ocr_mock_ms", () => ocrFramesMock(sql, env, id));
await timed("segment_ms", () => segmentAuctionFromSignals(sql, id));
await timed("reconcile_ms", () => reconcileSales(sql, id));

const result = {
  generatedAt: new Date().toISOString(),
  fixture: "fixtures/sample-live.mp4",
  recordingId: id,
  profile: env.profile.profile,
  timingsMs: timings,
  totalMs: Object.values(timings).reduce((a, b) => a + b, 0),
  note: "Measured on synthetic fixture; not a production live video benchmark.",
};

const outPath = join(import.meta.dir, "../../../BENCHMARK.results.json");
await Bun.write(outPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
await sql.end({ timeout: 5 });
