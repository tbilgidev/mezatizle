/** Resolve video seek offset (seconds) from sale / evidence / title. */

export function resolveOffsetMs(opts: {
  offsetMs?: number | null;
  evidence?: Array<Record<string, unknown>>;
  productTitle?: string | null;
  auctionEvent?: Record<string, unknown> | null;
}): number | null {
  if (opts.offsetMs != null && Number.isFinite(Number(opts.offsetMs))) {
    return Math.max(0, Number(opts.offsetMs));
  }
  if (opts.auctionEvent?.offset_ms != null) {
    const n = Number(opts.auctionEvent.offset_ms);
    if (Number.isFinite(n)) return Math.max(0, n);
  }
  for (const e of opts.evidence ?? []) {
    const payload = e.payload as { offsetMs?: number } | null;
    if (payload?.offsetMs != null && Number.isFinite(Number(payload.offsetMs))) {
      return Math.max(0, Number(payload.offsetMs));
    }
  }
  const title = opts.productTitle ?? "";
  const m = String(title).match(/@\s*(\d+)\s*ms/i);
  if (m) return Math.max(0, Number(m[1]));
  return null;
}

export function formatTimecode(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rem = s % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(rem).padStart(2, "0");
  if (h > 0) return `${h}:${mm}:${ss}`;
  return `${mm}:${ss}`;
}
