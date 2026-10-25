/** Normalize + time-window helpers for review-player comment overlay. */

export type ReviewComment = {
  id: string;
  offsetMs: number;
  author: string | null;
  body: string;
  source: string | null;
};

/** How long a comment stays “active” on the HUD after its offset (ms). */
export const COMMENT_HOLD_MS = 8_000;

export function normalizeReviewComments(
  rows: Array<Record<string, unknown>> | null | undefined,
): ReviewComment[] {
  if (!Array.isArray(rows)) return [];
  const out: ReviewComment[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] ?? {};
    const body = String(r.body ?? "").trim();
    if (!body) continue;
    const offsetRaw = r.offsetMs ?? r.offset_ms ?? 0;
    const offsetMs = Number(offsetRaw);
    if (!Number.isFinite(offsetMs)) continue;
    const authorRaw = r.authorUsername ?? r.author_username;
    const author =
      authorRaw != null && String(authorRaw).trim()
        ? String(authorRaw).trim().replace(/^@/, "")
        : null;
    out.push({
      id: String(r.id ?? `c-${i}-${Math.round(offsetMs)}`),
      offsetMs: Math.max(0, offsetMs),
      author,
      body,
      source: r.source != null ? String(r.source) : null,
    });
  }
  out.sort((a, b) => a.offsetMs - b.offsetMs);
  return out;
}

/** Comments whose cue window covers `currentMs` (arrived and still holding). */
export function activeCommentsAt(
  comments: ReviewComment[],
  currentMs: number,
  holdMs = COMMENT_HOLD_MS,
): ReviewComment[] {
  const t = Math.max(0, currentMs);
  return comments.filter(
    (c) => c.offsetMs <= t && t < c.offsetMs + holdMs,
  );
}

/** Newest active comment (top of HUD). */
export function latestActiveComment(
  comments: ReviewComment[],
  currentMs: number,
  holdMs = COMMENT_HOLD_MS,
): ReviewComment | null {
  const active = activeCommentsAt(comments, currentMs, holdMs);
  return active.length ? active[active.length - 1]! : null;
}

/** Index of the last comment that has started by `currentMs` (−1 if none). */
export function currentCommentIndex(
  comments: ReviewComment[],
  currentMs: number,
): number {
  const t = Math.max(0, currentMs);
  let idx = -1;
  for (let i = 0; i < comments.length; i++) {
    if (comments[i]!.offsetMs <= t) idx = i;
    else break;
  }
  return idx;
}
