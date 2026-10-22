/**
 * Ban-safe live comment capture helpers.
 *
 * Design: maximize catch rate within polite limits — never spam IG.
 * Prefer freeze recovery + dual channel over raw high-frequency polling.
 */

export type LiveCommentChannel = "live_api" | "live_dom";

/** API get_comment cadence while kaydediliyor (ms). Safe band ~3–5s. */
export const COMMENT_API_POLL_MIN_MS = Number(
  process.env.LIVE_COMMENT_API_POLL_MIN_MS ?? "3000",
);
export const COMMENT_API_POLL_MAX_MS = Number(
  process.env.LIVE_COMMENT_API_POLL_MAX_MS ?? "5000",
);

/** DOM comment list scrape cadence (ms). Secondary channel — moderate. */
export const COMMENT_DOM_SCRAPE_MIN_MS = Number(
  process.env.LIVE_COMMENT_DOM_SCRAPE_MIN_MS ?? "8000",
);
export const COMMENT_DOM_SCRAPE_MAX_MS = Number(
  process.env.LIVE_COMMENT_DOM_SCRAPE_MAX_MS ?? "15000",
);

/** No new comments while heartbeat says live → freeze (minutes). */
export const COMMENT_FREEZE_MINUTES = Number(
  process.env.LIVE_COMMENT_FREEZE_MIN ?? "3",
);

/** Soft viewer refresh cooldown after a freeze recovery (minutes). */
export const COMMENT_SOFT_REFRESH_COOLDOWN_MIN = Number(
  process.env.LIVE_COMMENT_SOFT_REFRESH_COOLDOWN_MIN ?? "4",
);

/** How far back (seconds) to rewind last_comment_ts on catch-up. */
export const COMMENT_CATCHUP_REWIND_SEC = Number(
  process.env.LIVE_COMMENT_CATCHUP_REWIND_SEC ?? "120",
);

/** Periodic catch-up interval (ms) — re-walk recent window even without freeze. */
export const COMMENT_CATCHUP_EVERY_MS = Number(
  process.env.LIVE_COMMENT_CATCHUP_EVERY_MS ?? String(90_000),
);

/** 429 / challenge backoff: start + cap (ms). Spirit of auto-follow ≥12 min. */
export const COMMENT_BACKOFF_START_MS = Number(
  process.env.LIVE_COMMENT_BACKOFF_START_MS ?? "30000",
);
export const COMMENT_BACKOFF_MAX_MS = Number(
  process.env.LIVE_COMMENT_BACKOFF_MAX_MS ?? String(12 * 60_000),
);

/** Fingerprint time bucket for DOM / no-pk dedupe (ms). */
export const COMMENT_FINGERPRINT_BUCKET_MS = 5_000;

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, Math.floor(n)));
}

/** Uniform jitter in [minMs, maxMs]. */
export function jitterMs(
  minMs: number,
  maxMs: number,
  random: () => number = Math.random,
): number {
  const lo = Math.min(minMs, maxMs);
  const hi = Math.max(minMs, maxMs);
  return Math.floor(lo + random() * (hi - lo + 1));
}

export function nextApiPollDelayMs(
  opts?: { rateLimited?: boolean; backoffMs?: number; random?: () => number },
): number {
  if (opts?.rateLimited && opts.backoffMs != null) {
    return Math.max(opts.backoffMs, COMMENT_API_POLL_MAX_MS);
  }
  return jitterMs(
    COMMENT_API_POLL_MIN_MS,
    COMMENT_API_POLL_MAX_MS,
    opts?.random,
  );
}

export function nextDomScrapeDelayMs(
  random: () => number = Math.random,
): number {
  return jitterMs(COMMENT_DOM_SCRAPE_MIN_MS, COMMENT_DOM_SCRAPE_MAX_MS, random);
}

/** Exponential backoff after 429/challenge; capped at COMMENT_BACKOFF_MAX_MS. */
export function nextCommentBackoffMs(
  prevBackoffMs: number,
  random: () => number = Math.random,
): number {
  const start = clamp(COMMENT_BACKOFF_START_MS, 15_000, COMMENT_BACKOFF_MAX_MS);
  const base = prevBackoffMs > 0 ? prevBackoffMs * 2 : start;
  const capped = Math.min(COMMENT_BACKOFF_MAX_MS, base);
  // ±10% jitter so multiple sessions don't sync-hammer
  const jittered = capped * (0.9 + random() * 0.2);
  return Math.floor(jittered);
}

export function isCommentFreeze(
  lastHitAt: number | null | undefined,
  nowMs: number,
  opts?: { freezeMinutes?: number; sessionStartedAt?: number },
): boolean {
  const freezeMin = opts?.freezeMinutes ?? COMMENT_FREEZE_MINUTES;
  const thresholdMs = freezeMin * 60_000;
  const anchor =
    lastHitAt != null && lastHitAt > 0
      ? lastHitAt
      : opts?.sessionStartedAt != null
        ? opts.sessionStartedAt
        : null;
  if (anchor == null) return false;
  // Don't freeze-flag in the first freeze window (comments may not have started)
  if (nowMs - anchor < thresholdMs) return false;
  return nowMs - anchor >= thresholdMs;
}

/** Rewind cursor for a recent-window catch-up (unix seconds). */
export function catchupCommentTs(
  lastCommentTs: number,
  nowUnixSec: number,
  rewindSec: number = COMMENT_CATCHUP_REWIND_SEC,
): number {
  const floor = Math.max(0, nowUnixSec - rewindSec);
  if (!lastCommentTs || lastCommentTs <= 0) return floor;
  return Math.max(floor, lastCommentTs - rewindSec);
}

export function commentFingerprint(opts: {
  username: string | null;
  text: string;
  createdAtMs: number | null;
  bucketMs?: number;
}): string {
  const bucket = opts.bucketMs ?? COMMENT_FINGERPRINT_BUCKET_MS;
  const user = (opts.username ?? "").toLowerCase().trim();
  const text = opts.text.trim().toLowerCase().replace(/\s+/g, " ");
  const t =
    opts.createdAtMs != null && Number.isFinite(opts.createdAtMs)
      ? Math.floor(opts.createdAtMs / bucket)
      : "na";
  return `${user}|${text}|${t}`;
}

export function ratePolicySummaryTr(): string {
  return (
    `API poll ${COMMENT_API_POLL_MIN_MS}-${COMMENT_API_POLL_MAX_MS}ms jitter; ` +
    `DOM scrape ${COMMENT_DOM_SCRAPE_MIN_MS}-${COMMENT_DOM_SCRAPE_MAX_MS}ms; ` +
    `429 backoff ${COMMENT_BACKOFF_START_MS}ms→${COMMENT_BACKOFF_MAX_MS}ms; ` +
    `freeze ${COMMENT_FREEZE_MINUTES}dk → soft refresh (ffmpeg dokunulmaz).`
  );
}
