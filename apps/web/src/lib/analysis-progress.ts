/**
 * Display helpers for analysis pipeline progress on Kayıtlar / Raporlar.
 * Prefer API `analysisProgress` (0–100) + `analysisStage` when present;
 * fall back to coarse % / TR stage from `status` until the worker ships fields.
 */

export type AnalysisProgressInfo = {
  /** True when analysis is in progress and we should show a progress line. */
  active: boolean;
  percent: number | null;
  stage: string | null;
  /** e.g. `Analiz %42 · Ses çözülüyor` */
  label: string;
};

const STAGE_TR: Record<string, string> = {
  probe: "Medya inceleniyor",
  probing: "Medya inceleniyor",
  probe_media: "Medya inceleniyor",
  extract: "Ses çıkarılıyor",
  extracting: "Ses çıkarılıyor",
  extract_audio: "Ses çıkarılıyor",
  extract_audio_frames: "Ses çıkarılıyor",
  extracted: "Ses hazır",
  asr: "Ses çözülüyor",
  transcribe: "Ses çözülüyor",
  transcribing: "Ses çözülüyor",
  ocr: "Görüntü okunuyor",
  ocr_frames: "Görüntü okunuyor",
  segment: "Mezât dilimleri",
  segment_auction: "Mezât dilimleri",
  reconcile: "Satış eşleştirme",
  reconcile_sales: "Satış eşleştirme",
  analyzing: "Mezât analizi",
  analyze: "Mezât analizi",
  finalize: "Sonuçlandırılıyor",
  finalizing: "Sonuçlandırılıyor",
  done: "Tamamlandı",
  tamamlandı: "Tamamlandı",
  tamamlandi: "Tamamlandı",
};

/** Coarse progress when API has not yet published analysisProgress. */
const STATUS_FALLBACK: Record<string, { percent: number; stage: string }> = {
  probing: { percent: 8, stage: "Medya inceleniyor" },
  ready: { percent: 15, stage: "Hazırlanıyor" },
  extracting: { percent: 30, stage: "Ses çıkarılıyor" },
  extracted: { percent: 40, stage: "Ses hazır" },
  transcribing: { percent: 55, stage: "Ses çözülüyor" },
  analyzing: { percent: 80, stage: "Mezât analizi" },
  // status=complete can still be analysisState=running (post-pipeline wrap-up)
  complete: { percent: 92, stage: "Sonuçlandırılıyor" },
};

function clampPercent(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function readPercent(r: Record<string, unknown>): number | null {
  const raw = r.analysisProgress ?? r.analysis_progress;
  if (raw == null || raw === "") return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return null;
  return clampPercent(n);
}

function translateStage(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const key = s.toLowerCase().replace(/\s+/g, "_");
  if (STAGE_TR[key]) return STAGE_TR[key];
  // Already Turkish / free-form from API — keep as-is
  if (/[ğüşıöçĞÜŞİÖÇ]/.test(s) || /\s/.test(s)) return s;
  return STAGE_TR[key] ?? s;
}

function readStage(r: Record<string, unknown>): string | null {
  const raw = r.analysisStage ?? r.analysis_stage;
  return translateStage(raw == null ? null : String(raw));
}

function analysisStateOf(r: Record<string, unknown>): string {
  return String(r.analysisState ?? r.analysis_state ?? "").toLowerCase();
}

function statusOf(r: Record<string, unknown>): string {
  return String(r.status ?? "").toLowerCase();
}

/** Whether this row should be treated as an in-flight analysis. */
export function isAnalysisRunning(r: Record<string, unknown>): boolean {
  const state = analysisStateOf(r);
  if (state === "running") return true;
  if (state === "done" || state === "failed" || state === "none") return false;
  // Fallback when analysisState missing
  return Boolean(STATUS_FALLBACK[statusOf(r)] && statusOf(r) !== "complete");
}

/**
 * Build progress line for a recording / report row.
 * Prefer API fields; fall back from status while the worker rolls out.
 */
export function analysisProgressInfo(
  r: Record<string, unknown>,
): AnalysisProgressInfo | null {
  const state = analysisStateOf(r);
  const status = statusOf(r);
  const running =
    state === "running" ||
    (state === "" && Boolean(STATUS_FALLBACK[status] && status !== "complete"));

  if (!running) return null;

  const apiPercent = readPercent(r);
  const apiStage = readStage(r);
  const fallback = STATUS_FALLBACK[status] ?? {
    percent: 50,
    stage: "Analiz sürüyor",
  };

  const percent = apiPercent ?? fallback.percent;
  const stage = apiStage ?? fallback.stage;
  const label =
    stage.length > 0
      ? `Analiz %${percent} · ${stage}`
      : `Analiz %${percent}`;

  return {
    active: true,
    percent,
    stage,
    label,
  };
}
