import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Sql } from "@mezatizle/db";
import type { AppEnv } from "../lib/env.ts";
import { safeJoinStorage } from "../lib/storage.ts";
import { recordApiUsage } from "../lib/cost.ts";

/** Local mock ASR for LOCAL profile when faster-whisper is unavailable. */
export async function transcribeMock(
  sql: Sql,
  env: AppEnv,
  recordingId: string,
) {
  const audioAbs = safeJoinStorage(
    env.storageRoot,
    "audio",
    `${recordingId}.wav`,
  );
  const exists = await Bun.file(audioAbs).exists();
  if (!exists) {
    // still seed synthetic Turkish auction lines for pipeline testing
  }
  const lines = [
    { start: 0, end: 2000, text: "Sıradaki ürün: lacivert ceket, açılış 500 TL" },
    { start: 2000, end: 4000, text: "@ayse_demo ben 600" },
    { start: 4000, end: 6000, text: "700 TL @mehmet_demo" },
    { start: 6000, end: 8000, text: "Satıldı @mehmet_demo 700 TL" },
  ];
  await sql`DELETE FROM transcript_segments WHERE recording_id = ${recordingId}`;
  for (const line of lines) {
    await sql`
      INSERT INTO transcript_segments (recording_id, start_ms, end_ms, text, confidence, source)
      VALUES (
        ${recordingId}, ${line.start}, ${line.end}, ${line.text}, ${0.5}, ${"mock_asr"}
      )
    `;
  }
  await recordApiUsage(sql, {
    provider: "local",
    operation: "asr_mock",
    units: lines.length,
    unitCostUsd: 0,
    recordingId,
  });
  await sql`
    UPDATE recordings SET status = 'transcribing', updated_at = now()
    WHERE id = ${recordingId}
  `;
  return { segments: lines.length, backend: "mock" };
}

export async function ocrFramesMock(
  sql: Sql,
  env: AppEnv,
  recordingId: string,
) {
  const framesDir = safeJoinStorage(env.storageRoot, "frames", recordingId);
  let count = 0;
  try {
    const files = (await readdir(framesDir)).filter((f) => f.endsWith(".jpg"));
    count = files.length;
  } catch {
    count = 0;
  }
  // Store OCR as comments-like notes in auction_events is Phase 3; here we record metric via api_usage
  await recordApiUsage(sql, {
    provider: "local",
    operation: "ocr_mock",
    units: count,
    unitCostUsd: 0,
    recordingId,
    meta: { note: "PaddleOCR unavailable; mock OCR counted frames only" },
  });
  return { frames: count, backend: "mock" };
}

export async function tryPythonWorker(
  script: "transcribe" | "ocr",
  recordingId: string,
  env: AppEnv,
): Promise<{ ok: boolean; backend?: string; detail?: string }> {
  const workerDir = join(import.meta.dir, "../../../../workers/extractor");
  const proc = Bun.spawn(
    ["python3", "tools.py", script, recordingId, env.storageRoot],
    {
      cwd: workerDir,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, DATABASE_URL: env.databaseUrl },
    },
  );
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) {
    return { ok: false, detail: stderr || stdout };
  }
  try {
    return { ok: true, ...JSON.parse(stdout) };
  } catch {
    return { ok: true, backend: "python", detail: stdout };
  }
}
