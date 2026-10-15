/**
 * Prefer same-origin (Vite proxy) so one Tailscale Funnel path works.
 * Under Funnel `/mezatizle`, BASE_URL is `/mezatizle/` so /api hits
 * `/mezatizle/api/...` (not Ozy at `/api`).
 */
const ENV_API = (import.meta.env.VITE_API_BASE ?? "").replace(/\/$/, "");
const BASE_URL = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");
const API_BASE = ENV_API || (BASE_URL === "" || BASE_URL === "/" ? "" : BASE_URL);

function url(path: string) {
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${API_BASE}${p}`;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url(path), init);
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const j = (await res.json()) as { error?: string };
      if (j.error) msg = j.error;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) return res.json() as Promise<T>;
  return res.text() as Promise<T>;
}

export type ReportListItem = {
  recordingId: string;
  sellerUsername: string;
  displayName: string | null;
  originalFilename: string;
  status: string;
  recordedAt: string | null;
  uploadedAt: string | null;
  durationSeconds: number | null;
  saleCount: number;
  needsReviewCount: number;
  confirmedCount: number;
  rejectedCount: number;
  sumAmountTry: number | null;
  currency: string;
  sourceType: string | null;
  avgEventConfidence: number | null;
  headline: string;
  /** Optional — present once analysis worker publishes progress. */
  analysisState?: string | null;
  analysisProgress?: number | null;
  analysisStage?: string | null;
};

/** One sale candidate inside a recording report (sales-first detail). */
export type ReportSale = {
  id: string;
  buyerUsername: string | null;
  amountCents: number | null;
  amountTry: number | null;
  status: string;
  productTitle: string | null;
  /** Longer product blurb when distinct from title. */
  productDescription: string | null;
  soldAt: string | null;
  /** Frame / product still — absolute or same-origin URL. */
  thumbnailUrl: string | null;
  /** How the sale was detected: transcript | ocr | comment | video | … */
  detectionMethod: string | null;
  /** 0–1 confidence when API provides it. */
  confidence: number | null;
  /** Timeline offset in muxed recording (ms) for video seek. */
  offsetMs: number | null;
};

export type ReportDetail = ReportListItem & {
  sales: ReportSale[];
  eventCounts: Record<string, number>;
  transcriptSegmentCount: number;
  commentCount: number;
  jobs: Array<{
    jobType: string;
    status: string;
    progressPercent: number;
    stage: string | null;
    finishedAt: string | null;
  }>;
};

/** Turn storage keys / relative paths into fetchable same-origin URLs. */
export function resolveMediaUrl(path: string | null | undefined): string | null {
  if (path == null) return null;
  const s = String(path).trim();
  if (!s) return null;
  if (/^(https?:|data:|blob:)/i.test(s)) return s;
  if (s.startsWith("/")) return url(s.startsWith("/api/") ? s : `/api${s}`);
  return url(`/api/files/${s.replace(/^\/+/, "")}`);
}

/** Normalize report sale rows (camel or snake, optional fields from analysis worker). */
export function normalizeReportSale(raw: Record<string, unknown>): ReportSale {
  const num = (v: unknown): number | null => {
    if (v == null || v === "") return null;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const str = (v: unknown): string | null => {
    if (v == null) return null;
    const s = String(v).trim();
    return s.length ? s : null;
  };
  const amountCents = num(raw.amountCents ?? raw.amount_cents);
  const amountTryDirect = num(raw.amountTry ?? raw.amount_try);
  const amountTry =
    amountTryDirect ?? (amountCents != null ? amountCents / 100 : null);
  let confidence = num(raw.confidence ?? raw.avgConfidence ?? raw.avg_confidence);
  if (confidence != null && confidence > 1) confidence = confidence / 100;

  const thumbRaw = str(
    raw.thumbnailUrl ??
      raw.thumbnail_url ??
      raw.thumbUrl ??
      raw.thumb_url ??
      raw.frameUrl ??
      raw.frame_url ??
      raw.imageUrl ??
      raw.image_url ??
      raw.imagePath ??
      raw.image_path,
  );

  return {
    id: String(raw.id ?? ""),
    buyerUsername: str(raw.buyerUsername ?? raw.buyer_username),
    amountCents,
    amountTry,
    status: String(raw.status ?? "candidate"),
    productTitle: str(raw.productTitle ?? raw.product_title ?? raw.title),
    productDescription: str(
      raw.productDescription ??
        raw.product_description ??
        raw.description ??
        raw.product_blurb,
    ),
    soldAt: str(raw.soldAt ?? raw.sold_at),
    thumbnailUrl: resolveMediaUrl(thumbRaw),
    detectionMethod: str(
      raw.detectionMethod ??
        raw.detection_method ??
        raw.method ??
        raw.source ??
        raw.evidenceSource ??
        raw.evidence_source,
    ),
    confidence,
    offsetMs: num(raw.offsetMs ?? raw.offset_ms ?? raw.seekMs ?? raw.seek_ms),
  };
}

export const api = {
  base: API_BASE || "(same-origin)",
  dashboard: () => request<Record<string, unknown>>("/api/dashboard"),
  settings: () => request<Record<string, unknown>>("/api/settings"),
  metrics: () => request<Record<string, unknown>>("/api/metrics"),
  recordings: () =>
    request<{ recordings: Array<Record<string, unknown>> }>("/api/recordings"),
  recording: (id: string) =>
    request<{
      recording: Record<string, unknown>;
      jobs: Array<Record<string, unknown>>;
    }>(`/api/recordings/${id}`),
  transcript: (id: string) =>
    request<{ segments: Array<Record<string, unknown>> }>(
      `/api/recordings/${id}/transcript`,
    ),
  events: (id: string) =>
    request<{ events: Array<Record<string, unknown>> }>(
      `/api/recordings/${id}/events`,
    ),
  sales: () => request<{ sales: Array<Record<string, unknown>> }>("/api/sales"),
  reports: () =>
    request<{
      reports: ReportListItem[];
      totals: {
        recordings: number;
        sales: number;
        needsReview: number;
        sumAmountTry: number;
        currency: string;
      };
    }>("/api/reports"),
  report: async (recordingId: string) => {
    const d = await request<{ report: ReportDetail & { sales?: Array<Record<string, unknown>> } }>(
      `/api/reports/${recordingId}`,
    );
    return {
      report: {
        ...d.report,
        sales: (d.report.sales ?? []).map((s) =>
          normalizeReportSale(s as Record<string, unknown>),
        ),
      } satisfies ReportDetail,
    };
  },
  evidence: (id: string) =>
    request<{
      sale: Record<string, unknown>;
      evidence: Array<Record<string, unknown>>;
      auctionEvent?: Record<string, unknown> | null;
      offsetMs?: number | null;
      explanationTr?: string;
      confidence?: number;
      gaps?: string[];
      windowMs?: number;
      transcriptAround?: Array<Record<string, unknown>>;
      commentsAround?: Array<Record<string, unknown>>;
    }>(`/api/sales/${id}/evidence`),
  /** Muxed recording MP4 (range-request friendly). */
  mediaUrl: (recordingId: string) => url(`/api/recordings/${recordingId}/media`),
  reviewSale: (id: string, status: string) =>
    request(`/api/sales/${id}/review`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    }),
  upload: async (form: FormData) => {
    const res = await fetch(url("/api/recordings/upload"), {
      method: "POST",
      body: form,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Yükleme başarısız");
    return data as { recordingId: string };
  },
  startLive: (body: {
    input: string;
    displayName?: string;
    notes?: string;
    maxDurationMinutes?: number | null;
  }) =>
    request<{
      recordingId: string;
      username: string;
      watchUrl: string;
      captureStatus: string;
      maxDurationMinutes?: number | null;
      policy?: { limitationTr?: string; message?: string };
    }>("/api/recordings/live", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  cancelLive: (id: string) =>
    request<{ ok: boolean }>(`/api/recordings/${id}/cancel-live`, {
      method: "POST",
    }),
  igSession: () =>
    request<{
      status: string;
      hasCookies: boolean;
      hasCredentials: boolean;
      usernameMasked: string | null;
      updatedAt: string | null;
      lastError: string | null;
      hintTr: string;
    }>("/api/settings/ig-session"),
  saveIgSessionJson: (body: {
    cookiesText?: string;
    cookiesPath?: string;
    username?: string;
    password?: string;
  }) =>
    request<Record<string, unknown>>("/api/settings/ig-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  saveIgCookiesFile: async (file: File) => {
    const fd = new FormData();
    fd.append("cookiesFile", file);
    const res = await fetch(url("/api/settings/ig-session"), {
      method: "POST",
      body: fd,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Çerez kaydı başarısız");
    return data as Record<string, unknown>;
  },
  clearIgSession: () =>
    request<Record<string, unknown>>("/api/settings/ig-session", {
      method: "DELETE",
    }),
  playwrightIgLogin: async (body: {
    username: string;
    password: string;
    headless?: boolean;
  }) => {
    const res = await fetch(url("/api/settings/ig-session/playwright-login"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as {
      error?: string;
      errorTr?: string;
      screenshotPath?: string | null;
      status?: string;
      hasCookies?: boolean;
      lastError?: string | null;
    };
    if (!res.ok) {
      const msg = data.errorTr || data.error || res.statusText || "Giriş başarısız";
      throw new Error(msg);
    }
    return data as Record<string, unknown>;
  },
  csvUrl: () => url("/api/sales/export.csv"),
  reportCsvUrl: (recordingId: string) =>
    url(`/api/reports/${recordingId}/export.csv`),
};
