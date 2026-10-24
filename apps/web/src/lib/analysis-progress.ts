/**
 * Display helpers for analysis pipeline progress on Kayıtlar / Raporlar.
 * Prefer API `analysisProgress` (0–100) + `analysisStage` when present.
 * Always show a progress line for running | failed | done (never hide % on fail).
 */

export type AnalysisTone = "yellow" | "red" | "green" | "muted";

export type AnalysisProgressInfo = {
  /** Show progress chip next to Rapor. */
  active: boolean;
  percent: number | null;
  stage: string | null;
  state: "running" | "failed" | "done" | "none" | "unknown";
  tone: AnalysisTone;
  className: string;
  /** e.g. `Analiz %40 · Analiz başarısız` */
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
  failed: "Analiz başarısız",
  error: "Analiz başarısız",
  done: "Tamam",
  tamamlandı: "Tamam",
  tamamlandi: "Tamam",
};

/** Coarse progress when API has not yet published analysisProgress. */
const STATUS_FALLBACK: Record<string, { percent: number; stage: string }> = {
  probing: { percent: 8, stage: "Medya inceleniyor" },
  ready: { percent: 15, stage: "Hazırlanıyor" },
  extracting: { percent: 30, stage: "Ses çıkarılıyor" },
  extracted: { percent: 40, stage: "Ses hazır" },
  transcribing: { percent: 55, stage: "Ses çözülüyor" },
  analyzing: { percent: 80, stage: "Mezât analizi" },
  complete: { percent: 92, stage: "Sonuçlandırılıyor" },
  failed: { percent: 40, stage: "Analiz başarısız" },
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

function resolveState(
  r: Record<string, unknown>,
): AnalysisProgressInfo["state"] {
  const state = analysisStateOf(r);
  if (state === "running" || state === "failed" || state === "done" || state === "none") {
    return state;
  }
  const status = statusOf(r);
  if (status === "failed") return "failed";
  if (STATUS_FALLBACK[status] && status !== "complete") return "running";
  if (status === "complete") return "done";
  return state ? "unknown" : "none";
}

/** Whether this row should be treated as an in-flight analysis. */
export function isAnalysisRunning(r: Record<string, unknown>): boolean {
  return resolveState(r) === "running";
}

export function isAnalysisFailed(r: Record<string, unknown>): boolean {
  return resolveState(r) === "failed";
}

/**
 * Build progress line for a recording / report row.
 * Shows for running (yellow), failed (red), done (green).
 */
export function analysisProgressInfo(
  r: Record<string, unknown>,
): AnalysisProgressInfo | null {
  const state = resolveState(r);
  const status = statusOf(r);

  if (state === "none" || state === "unknown") {
    // No analysis yet — hide progress chip (Rapor link stays red via reportLinkTone).
    return null;
  }

  const apiPercent = readPercent(r);
  const apiStage = readStage(r);
  const fallback = STATUS_FALLBACK[status];

  let percent: number;
  let stage: string;
  let tone: AnalysisTone;
  let className: string;

  if (state === "failed") {
    percent = apiPercent ?? fallback?.percent ?? 40;
    stage = apiStage ?? "Analiz başarısız";
    tone = "red";
    className = "text-rose";
  } else if (state === "done") {
    percent = apiPercent ?? 100;
    stage = apiStage ?? "Tamam";
    tone = "green";
    className = "text-emerald";
  } else {
    // running
    percent = apiPercent ?? fallback?.percent ?? 50;
    stage = apiStage ?? fallback?.stage ?? "Analiz sürüyor";
    tone = "yellow";
    className = "text-amber";
  }

  const label =
    stage.length > 0 ? `Analiz %${percent} · ${stage}` : `Analiz %${percent}`;

  return {
    active: true,
    percent,
    stage,
    state,
    tone,
    className,
    label,
  };
}
