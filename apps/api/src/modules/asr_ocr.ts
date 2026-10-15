import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Sql } from "@mezatizle/db";
import type { AppEnv } from "../lib/env.ts";
import { safeJoinStorage } from "../lib/storage.ts";
import { recordApiUsage } from "../lib/cost.ts";

/** Repo root (…/mezatizle) — asr_ocr lives at apps/api/src/modules/. */
const REPO_ROOT = join(import.meta.dir, "../../../..");

/**
 * Resolve Python interpreter to an **absolute** path.
 * Spawn cwd is `workers/extractor` — never return `./.venv/...` (ENOENT).
 */
export function resolvePythonBin(): string {
  const candidates: string[] = [];
  const fromEnv = process.env.PYTHON_BIN?.trim();
  if (fromEnv) {
    if (fromEnv.startsWith("/") || /^[A-Za-z]:[\\/]/.test(fromEnv)) {
      candidates.push(fromEnv);
    } else {
      // "./.venv/bin/python3" → repo-root absolute
      candidates.push(join(REPO_ROOT, fromEnv.replace(/^\.\//, "")));
    }
  }
  candidates.push(join(REPO_ROOT, ".venv/bin/python3"));
  candidates.push("/home/tolga/projects/mezatizle/.venv/bin/python3");
  for (const cand of candidates) {
    const check = Bun.spawnSync(["test", "-x", cand]);
    if (check.exitCode === 0) return cand;
  }
  // Last resort: PATH python3 (still absolute via `command -v` when possible)
  const which = Bun.spawnSync(["bash", "-lc", "command -v python3"], {
    stdout: "pipe",
  });
  const resolved = new TextDecoder()
    .decode(which.stdout)
    .trim();
  if (resolved.startsWith("/")) return resolved;
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
): Promise<{ ok: boolean; backend?: string; detail?: string; [k: string]: unknown }> {
  const workerDir = join(import.meta.dir, "../../../../workers/extractor");
  const python = resolvePythonBin();
  if (!python.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(python)) {
    return {
      ok: false,
      detail: `PYTHON_BIN must be absolute (got ${JSON.stringify(python)}); set PYTHON_BIN=/home/tolga/projects/mezatizle/.venv/bin/python3`,
    };
  }
  const proc = Bun.spawn(
    [python, "tools.py", script, recordingId, env.storageRoot],
    {
      cwd: workerDir,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        PYTHON_BIN: python,
        DATABASE_URL: env.databaseUrl,
        WHISPER_MODEL: process.env.WHISPER_MODEL ?? "small",
        OCR_ENGINE: process.env.OCR_ENGINE ?? "tesseract",
        OCR_FPS:
          process.env.OCR_FPS ??
          String(1 / Math.max(0.1, env.frameIntervalSeconds)),
        // IG Live portrait: comment stack bottom-LEFT (not product pane on right)
        OCR_CROP_FRAC: process.env.OCR_CROP_FRAC ?? "0.02,0.48,0.62,0.94",
        OCR_FRAME_STRIDE: process.env.OCR_FRAME_STRIDE ?? "2",
        OCR_MAX_FRAMES: process.env.OCR_MAX_FRAMES ?? "320",
        OCR_MAX_WIDTH: process.env.OCR_MAX_WIDTH ?? "480",
        OCR_MAX_HEIGHT: process.env.OCR_MAX_HEIGHT ?? "640",
        OCR_FRAME_TIMEOUT_S: process.env.OCR_FRAME_TIMEOUT_S ?? "12",
        TESSERACT_LANG: process.env.TESSERACT_LANG ?? "tur+eng",
        TESSERACT_CONFIG: process.env.TESSERACT_CONFIG ?? "--psm 6 --oem 1",
      },
    },
  );
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  let parsed: Record<string, unknown> | null = null;
  try {
    const line = stdout.trim().split("\n").filter(Boolean).pop() ?? "";
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    parsed = null;
  }
  if (code !== 0 || !parsed?.ok) {
    return {
      ok: false,
      detail: String(
        parsed?.error ?? (stderr || stdout || `exit ${code}`),
      ),
      backend: typeof parsed?.backend === "string" ? parsed.backend : undefined,
    };
  }
  return { ok: true, ...parsed };
}
