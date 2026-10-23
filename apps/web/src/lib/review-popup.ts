/**
 * Open evidence review (video + live comments) in a separate browser window
 * so the operator can place it beside the analysis tab on a wide screen.
 */

export type ReviewPopupParams = {
  recordingId: string;
  offsetMs: number;
  saleId?: string | null;
};

/** Absolute Funnel-aware URL for the review popup route. */
export function reviewPopupUrl(params: ReviewPopupParams): string {
  const base = (import.meta.env.BASE_URL || "/").replace(/\/$/, "") || "";
  const q = new URLSearchParams();
  q.set("recordingId", params.recordingId);
  q.set("offsetMs", String(Math.max(0, Math.round(params.offsetMs))));
  if (params.saleId) q.set("saleId", params.saleId);
  const path = `${base}/review-popup?${q.toString()}`;
  if (typeof window === "undefined") return path;
  return `${window.location.origin}${path.startsWith("/") ? path : `/${path}`}`;
}

const POPUP_FEATURES =
  "popup=yes,width=1280,height=820,left=80,top=40,menubar=no,toolbar=no,location=yes,status=no,resizable=yes,scrollbars=yes";

/**
 * Opens (or focuses) the review popup. Returns the Window | null from window.open.
 */
export function openReviewPopup(params: ReviewPopupParams): Window | null {
  const url = reviewPopupUrl(params);
  const name = `mezatizle-review-${params.recordingId.slice(0, 8)}`;
  const win = window.open(url, name, POPUP_FEATURES);
  if (win) {
    try {
      win.focus();
    } catch {
      /* cross-origin / closed */
    }
  }
  return win;
}
