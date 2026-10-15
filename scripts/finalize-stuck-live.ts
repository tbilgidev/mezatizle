/**
 * Finalize a stuck live recording whose ffmpeg already exited (or force-stop).
 * Usage: bun scripts/finalize-stuck-live.ts <recordingId> [--kill]
 */
import { rename, unlink, stat } from "node:fs/promises";
import { join } from "node:path";
import postgres from "postgres";
import { loadEnv } from "../apps/api/src/lib/env.ts";
import { enqueueAnalysisPipeline } from "../apps/api/src/modules/ingestion.ts";
import { probeAvSync } from "../apps/api/src/lib/ffmpeg.ts";
import { stopLiveViewerPresence } from "../apps/api/src/modules/ig_live_playwright.ts";

const recordingId = process.argv[2];
const doKill = process.argv.includes("--kill");
if (!recordingId) {
  console.error("Usage: bun scripts/finalize-stuck-live.ts <recordingId> [--kill]");
  process.exit(1);
}

const env = loadEnv();
const sql = postgres(process.env.DATABASE_URL ?? env.databaseUrl, { max: 1 });

const rows = await sql<{
  status: string;
  process_pid: number | null;
  max_duration_minutes: number | null;
  capture_started_at: Date | null;
  capture_status: string;
}[]>`
  SELECT lc.status, lc.process_pid, lc.max_duration_minutes,
         r.capture_started_at, r.capture_status
  FROM live_captures lc
  JOIN recordings r ON r.id = lc.recording_id
  WHERE lc.recording_id = ${recordingId}
`;
if (!rows[0]) {
  console.error("not found");
  await sql.end();
  process.exit(1);
}
const row = rows[0];
console.log(JSON.stringify({ recordingId, ...row }, null, 2));

const pid = row.process_pid != null ? Number(row.process_pid) : null;
if (doKill && pid && pid > 1) {
  try {
    process.kill(pid, "SIGTERM");
    console.log("sent SIGTERM to", pid);
    await Bun.sleep(2000);
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already dead */
    }
  } catch {
    console.log("pid already dead", pid);
  }
}

await stopLiveViewerPresence(recordingId).catch(() => undefined);

const destAbs = join(env.storageRoot, "recordings", `${recordingId}.mp4`);
const partAbs = `${destAbs}.part.mp4`;

let partBytes = 0;
try {
  partBytes = (await stat(partAbs)).size;
} catch {
  try {
    partBytes = (await stat(destAbs)).size;
  } catch {
    partBytes = 0;
  }
}

if (partBytes < 64_000) {
  console.error("part too small", partBytes);
  await sql`
    UPDATE live_captures SET status = 'failed', process_pid = NULL,
      last_probe_detail = ${"Stuck finalize: part too small"}, updated_at = now()
    WHERE recording_id = ${recordingId}
  `;
  await sql`
    UPDATE recordings SET status = 'failed', capture_status = 'hata',
      capture_error = ${"Kayıt dosyası yetersiz"}, capture_ended_at = now(), updated_at = now()
    WHERE id = ${recordingId}
  `;
  await sql.end();
  process.exit(1);
}

try {
  await rename(partAbs, destAbs);
} catch {
  // maybe already renamed
  try {
    await stat(destAbs);
  } catch (err) {
    console.error("rename failed", err);
    await sql.end();
    process.exit(1);
  }
}

const finalBytes = (await stat(destAbs)).size;
let syncDetail = "A/V sync check skipped";
try {
  const sync = await probeAvSync(env.ffprobePath, destAbs);
  syncDetail = sync.detailTr;
} catch (err) {
  syncDetail = err instanceof Error ? err.message : String(err);
}

await sql`
  UPDATE live_captures
  SET status = 'completed', process_pid = NULL,
      last_probe_detail = ${`manual_finalize ${syncDetail}`}, updated_at = now()
  WHERE recording_id = ${recordingId}
`;
await sql`
  UPDATE recordings
  SET status = 'uploaded', capture_status = 'bitti',
      capture_ended_at = now(), capture_bytes = ${finalBytes},
      file_size_bytes = ${finalBytes}, capture_error = NULL, updated_at = now()
  WHERE id = ${recordingId}
`;
await enqueueAnalysisPipeline(sql, recordingId);

const jobs = await sql<{ id: string; stage: string; status: string }[]>`
  SELECT id::text, stage, status FROM processing_jobs
  WHERE recording_id = ${recordingId}
  ORDER BY created_at DESC LIMIT 5
`;

console.log(
  JSON.stringify(
    {
      ok: true,
      finalBytes,
      syncDetail,
      capture_status: "bitti",
      jobs,
    },
    null,
    2,
  ),
);
await sql.end();
