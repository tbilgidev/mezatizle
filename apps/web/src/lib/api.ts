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
  evidence: (id: string) =>
    request<{
      sale: Record<string, unknown>;
      evidence: Array<Record<string, unknown>>;
    }>(`/api/sales/${id}/evidence`),
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
  csvUrl: () => url("/api/sales/export.csv"),
};
