import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Sql } from "@mezatizle/db";
import type { AppEnv } from "../lib/env.ts";
import { safeJoinStorage } from "../lib/storage.ts";
import { recordApiUsage } from "../lib/cost.ts";

/** Resolve Python interpreter: repo `.venv` first, then PYTHON_BIN, then python3. */
export function resolvePythonBin(): string {
  const fromEnv = process.env.PYTHON_BIN?.trim();
  if (fromEnv) return fromEnv;
  const venv = join(import.meta.dir, "../../../../.venv/bin/python3");
  const check = Bun.spawnSync(["test", "-x", venv]);
  if (check.exitCode === 0) return venv;
  return "python3";
}

/** Local mock ASR for unit tests only (FORCE_MOCK_ASR=1). */
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
      AND status NOT IN ('complete', 'analyzing', 'failed', 'cancelled')
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
  await recordApiUsage(sql, {
    provider: "local",
    operation: "ocr_mock",
    units: count,
    unitCostUsd: 0,
    recordingId,
    meta: { note: "FORCE_MOCK_OCR=1 test path" },
  });
  return { frames: count, backend: "mock" };
}

export async function tryPythonWorker(
  script: "transcribe" | "ocr",
  recordingId: string,
  env: AppEnv,
  onHeartbeat?: () => void | Promise<void>,
): Promise<{ ok: boolean; backend?: string; detail?: string; [k: string]: unknown }> {
  const workerDir = join(import.meta.dir, "../../../../workers/extractor");
  const python = resolvePythonBin();
  const proc = Bun.spawn(
    [python, "tools.py", script, recordingId, env.storageRoot],
    {
      cwd: workerDir,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        DATABASE_URL: env.databaseUrl,
        WHISPER_MODEL: process.env.WHISPER_MODEL ?? "small",
        OCR_ENGINE: process.env.OCR_ENGINE ?? "tesseract",
        OCR_FPS:
          process.env.OCR_FPS ??
          String(1 / Math.max(0.1, env.frameIntervalSeconds)),
        OCR_CROP_FRAC: process.env.OCR_CROP_FRAC ?? "0.55,0.40,0.98,0.90",
        OCR_FRAME_STRIDE: process.env.OCR_FRAME_STRIDE ?? "3",
        OCR_MAX_FRAMES: process.env.OCR_MAX_FRAMES ?? "200",
        OCR_MAX_WIDTH: process.env.OCR_MAX_WIDTH ?? "360",
        OCR_MAX_HEIGHT: process.env.OCR_MAX_HEIGHT ?? "480",
        OCR_FRAME_TIMEOUT_S: process.env.OCR_FRAME_TIMEOUT_S ?? "8",
        TESSERACT_LANG: process.env.TESSERACT_LANG ?? "eng",
        TESSERACT_CONFIG: process.env.TESSERACT_CONFIG ?? "--psm 6 --oem 1",
      },
    },
  );
  const hb = onHeartbeat
    ? setInterval(() => {
        void Promise.resolve(onHeartbeat()).catch(() => {});
      }, 25_000)
    : null;
  let stdout = "";
  let stderr = "";
  let code = 1;
  try {
    const [outText, errText, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    stdout = outText;
    stderr = errText;
    code = exitCode;
  } finally {
    if (hb) clearInterval(hb);
  }
  let parsed: Record<string, unknown> | null = null;
  try {
    const line = stdout.trim().split("\n").filter(Boolean).pop() ?? "";
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    parsed = null;
  }
  if (code !== 0 || !parsed?.ok) {
    const detail = String(
      parsed?.error ?? (stderr || stdout || `exit ${code}`),
    );
    return {
      ok: false,
      detail: detail.length > 1500 ? `${detail.slice(0, 400)}…${detail.slice(-800)}` : detail,
      backend: typeof parsed?.backend === "string" ? parsed.backend : undefined,
    };
  }
  return { ok: true, ...parsed };
}
