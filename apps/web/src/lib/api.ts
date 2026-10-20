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
  const ct = res.headers.get("content-type") || "";
  if (!res.ok) {
    let msg = res.statusText || `HTTP ${res.status}`;
    try {
      if (ct.includes("application/json")) {
        const j = (await res.json()) as { error?: string };
        if (j.error) msg = j.error;
      }
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  // SPA HTML fallback under /api looks like "empty lists" — reject explicitly.
  if (ct.includes("text/html")) {
    throw new Error(
      "API yanıtı HTML döndü (proxy/API kapalı olabilir). Sayfayı yenileyin.",
    );
  }
  if (ct.includes("application/json") || ct === "") {
    const text = await res.text();
    if (!text.trim()) {
      throw new Error("API boş yanıt döndü.");
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error("API JSON çözülemedi.");
    }
  }
  return res.text() as Promise<T>;
}

/** Pull recordings array from list payload (tolerant of nested shapes). */
export function extractRecordingsArray(
  payload: unknown,
): Array<Record<string, unknown>> {
  if (!payload || typeof payload !== "object") return [];
  const root = payload as Record<string, unknown>;
  const candidates = [root.recordings, root.items, root.rows, root.data];
  for (const c of candidates) {
    if (Array.isArray(c)) {
      return c.filter((x) => x && typeof x === "object") as Array<
        Record<string, unknown>
      >;
    }
    if (c && typeof c === "object") {
      const o = c as Record<string, unknown>;
      if (Array.isArray(o.recordings)) return extractRecordingsArray(o);
      if (Array.isArray(o.items)) return extractRecordingsArray(o);
    }
  }
  return [];
}

/** Pull reports array from list payload. */
export function extractReportsArray(payload: unknown): ReportListItem[] {
  if (!payload || typeof payload !== "object") return [];
  const root = payload as Record<string, unknown>;
  const candidates = [root.reports, root.items, root.rows];
  for (const c of candidates) {
    if (Array.isArray(c)) return c as ReportListItem[];
  }
  return [];
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
  /** Funnel KPIs (names may vary — UI reads via extractReportKpis). */
  productsOffered?: number | null;
  products_offered?: number | null;
  totalAskTry?: number | null;
  total_ask_try?: number | null;
  productsSold?: number | null;
  products_sold?: number | null;
  totalSoldTry?: number | null;
  total_sold_try?: number | null;
};

/** One sale candidate inside a recording report (sales-first detail). */
export type ReportSale = {
  id: string;
  productId: string | null;
  buyerUsername: string | null;
  /** Spoken name when IG handle unknown. */
  spokenBuyerName: string | null;
  amountCents: number | null;
  amountTry: number | null;
  status: string;
  productTitle: string | null;
  /** Longer product blurb when distinct from title. */
  productDescription: string | null;
  soldAt: string | null;
  /** Frame / product still — absolute or same-origin URL. */
  thumbnailUrl: string | null;
  /** How the sale was detected: saleMethod / transcript / ocr / … */
  detectionMethod: string | null;
  /** 0–1 confidence when API provides it. */
  confidence: number | null;
  /** Timeline offset in muxed recording (ms) for video seek. */
  offsetMs: number | null;
  explanationTr: string | null;
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
  // Storage key products/<uuid>.jpg → product image route when possible
  const productMatch = s.match(/^products\/([0-9a-f-]{36})\.jpe?g$/i);
  if (productMatch) return url(`/api/products/${productMatch[1]}/image`);
  return url(`/api/files/${s.replace(/^\/+/, "")}`);
}

/**
 * Pull the sales array from whatever shape GET /api/reports/:id returns.
 * Prefer `report.sales`; also accept nested `{ items|rows }` / top-level arrays.
 */
export function extractSalesArray(payload: unknown): Array<Record<string, unknown>> {
  const asRows = (v: unknown): Array<Record<string, unknown>> | null => {
    if (Array.isArray(v)) {
      return v.filter((x) => x && typeof x === "object") as Array<
        Record<string, unknown>
      >;
    }
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (Array.isArray(o.items)) return asRows(o.items);
      if (Array.isArray(o.rows)) return asRows(o.rows);
      if (Array.isArray(o.sales)) return asRows(o.sales);
    }
    return null;
  };

  if (!payload || typeof payload !== "object") return [];
  const root = payload as Record<string, unknown>;
  const report =
    root.report && typeof root.report === "object"
      ? (root.report as Record<string, unknown>)
      : root;

  const candidates = [
    report.sales,
    report.saleCandidates,
    report.sale_candidates,
    report.candidates,
    report.items,
    root.sales,
  ];
  for (const c of candidates) {
    const rows = asRows(c);
    if (rows && rows.length) return rows;
  }
  // Empty array is still valid (no sales) — distinguish from missing
  for (const c of candidates) {
    if (Array.isArray(c)) return [];
  }
  return [];
}

/** Normalize report sale rows (camel or snake, optional nested product_attributes). */
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

  const attrsRaw =
    raw.productAttributes ??
    raw.product_attributes ??
    raw.attributes ??
    null;
  const attrs =
    attrsRaw && typeof attrsRaw === "object" && !Array.isArray(attrsRaw)
      ? (attrsRaw as Record<string, unknown>)
      : null;

  const productId = str(raw.productId ?? raw.product_id);

  const amountCents = num(raw.amountCents ?? raw.amount_cents);
  const amountTryDirect = num(raw.amountTry ?? raw.amount_try);
  const amountTry =
    amountTryDirect ?? (amountCents != null ? amountCents / 100 : null);

  let confidence =
    num(raw.confidence ?? raw.avgConfidence ?? raw.avg_confidence) ??
    num(attrs?.confidence);
  if (confidence != null && confidence > 1) confidence = confidence / 100;

  const thumbRaw =
    str(
      raw.thumbnailUrl ??
        raw.thumbnail_url ??
        raw.thumbUrl ??
        raw.thumb_url ??
        raw.frameUrl ??
        raw.frame_url ??
        raw.imageUrl ??
        raw.image_url ??
        raw.imagePath ??
        raw.image_path ??
        attrs?.imagePath ??
        attrs?.image_path ??
        attrs?.thumbnailUrl,
    ) ?? (productId ? `/api/products/${productId}/image` : null);

  return {
    id: String(raw.id ?? ""),
    productId,
    buyerUsername: str(raw.buyerUsername ?? raw.buyer_username),
    spokenBuyerName: str(
      raw.spokenBuyerName ??
        raw.spoken_buyer_name ??
        attrs?.spokenBuyerName,
    ),
    amountCents,
    amountTry,
    status: String(raw.status ?? "candidate"),
    productTitle: str(raw.productTitle ?? raw.product_title ?? raw.title),
    productDescription: str(
      raw.productDescription ??
        raw.product_description ??
        raw.description ??
        raw.product_blurb ??
        raw.explanationTr,
    ),
    soldAt: str(raw.soldAt ?? raw.sold_at),
    thumbnailUrl: resolveMediaUrl(thumbRaw),
    detectionMethod: str(
      raw.saleMethod ??
        raw.sale_method ??
        raw.detectionMethod ??
        raw.detection_method ??
        raw.method ??
        raw.source ??
        attrs?.saleMethod ??
        raw.evidenceSource ??
        raw.evidence_source,
    ),
    confidence,
    offsetMs:
      num(raw.offsetMs ?? raw.offset_ms ?? raw.seekMs ?? raw.seek_ms) ??
      num(attrs?.offsetMs),
    explanationTr: str(raw.explanationTr ?? raw.explanation_tr),
  };
}

export const api = {
  base: API_BASE || "(same-origin)",
  dashboard: () => request<Record<string, unknown>>("/api/dashboard"),
  settings: () => request<Record<string, unknown>>("/api/settings"),
  metrics: () => request<Record<string, unknown>>("/api/metrics"),
  recordings: async () => {
    const d = await request<Record<string, unknown>>("/api/recordings");
    return { recordings: extractRecordingsArray(d) };
  },
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
  reports: async () => {
    const d = await request<Record<string, unknown>>("/api/reports");
    const totalsRaw =
      d.totals && typeof d.totals === "object"
        ? (d.totals as Record<string, unknown>)
        : {};
    return {
      reports: extractReportsArray(d),
      totals: {
        recordings: Number(totalsRaw.recordings ?? 0),
        sales: Number(totalsRaw.sales ?? 0),
        needsReview: Number(totalsRaw.needsReview ?? 0),
        sumAmountTry: Number(totalsRaw.sumAmountTry ?? 0),
        currency: String(totalsRaw.currency ?? "TRY"),
      },
    };
  },
  report: async (recordingId: string) => {
    const d = await request<Record<string, unknown>>(
      `/api/reports/${recordingId}`,
    );
    const reportObj =
      d.report && typeof d.report === "object"
        ? (d.report as Record<string, unknown>)
        : d;
    const sales = extractSalesArray(d).map((s) => normalizeReportSale(s));
    const jobs = Array.isArray(reportObj.jobs)
      ? (reportObj.jobs as ReportDetail["jobs"])
      : [];
    const eventCounts =
      reportObj.eventCounts && typeof reportObj.eventCounts === "object"
        ? (reportObj.eventCounts as Record<string, number>)
        : {};
    return {
      report: {
        ...(reportObj as unknown as ReportDetail),
        sales,
        jobs,
        eventCounts,
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
  /** Soft cascade delete one recording (+ derived analysis / storage). */
  deleteRecording: (id: string) =>
    request<{
      ok: boolean;
      recordingId: string;
      deleted: boolean;
      orphanSellersRemoved?: string[];
    }>(`/api/recordings/${id}`, { method: "DELETE" }),
  /** Batch delete — prefer this for multi-select. */
  bulkDeleteRecordings: (ids: string[]) =>
    request<{
      ok: boolean;
      deletedCount: number;
      orphanSellersRemoved?: string[];
      results?: Array<{
        recordingId: string;
        deleted: boolean;
        error?: string;
      }>;
    }>("/api/recordings/bulk-delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids }),
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
  autoFollowLive: () =>
    request<{
      enabled: boolean;
      pollIntervalMs: number;
      loopStarted: boolean;
      lastPollAt: string | null;
      lastPollOk: boolean | null;
      lastError: string | null;
      lastDetail: string | null;
      lastLivesSeen: Array<{ username: string; broadcastId: string | null }>;
      currentlyWatching: Array<{
        username: string;
        recordingId: string;
        broadcastId: string | null;
        captureStatus: string | null;
      }>;
      scanPaused: boolean;
      tickCount: number;
      startedAt: string | null;
      labelTr: string;
      hintTr: string;
      cookiesReady: boolean;
    }>("/api/settings/auto-follow-live"),
  setAutoFollowLive: (body: { enabled?: boolean; pollIntervalMs?: number }) =>
    request<Record<string, unknown>>("/api/settings/auto-follow-live", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  pollAutoFollowLiveNow: (body?: { dryRun?: boolean }) =>
    request<Record<string, unknown>>("/api/settings/auto-follow-live/poll-now", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? { dryRun: true }),
    }),
  csvUrl: () => url("/api/sales/export.csv"),
  reportCsvUrl: (recordingId: string) =>
    url(`/api/reports/${recordingId}/export.csv`),
};
