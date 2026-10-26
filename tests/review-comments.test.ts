import { describe, expect, test } from "bun:test";
import {
  COMMENT_HOLD_MS,
  activeCommentsAt,
  currentCommentIndex,
  latestActiveComment,
  normalizeReviewComments,
} from "../apps/web/src/lib/review-comments.ts";

describe("review-comments", () => {
  test("normalize sorts by offset and drops empty bodies", () => {
    const rows = normalizeReviewComments([
      { id: "b", offset_ms: 5000, author_username: "bob", body: "aldım" },
      { id: "a", offsetMs: 1000, authorUsername: "@alice", body: "merhaba" },
      { id: "x", offset_ms: 2000, body: "   " },
    ]);
    expect(rows.map((r) => r.id)).toEqual(["a", "b"]);
    expect(rows[0]!.author).toBe("alice");
    expect(rows[1]!.offsetMs).toBe(5000);
  });

  test("active window matches hold duration", () => {
    const comments = normalizeReviewComments([
      { id: "1", offset_ms: 10_000, body: "bir" },
      { id: "2", offset_ms: 20_000, body: "iki" },
    ]);
    expect(activeCommentsAt(comments, 10_000).map((c) => c.id)).toEqual(["1"]);
    expect(
      activeCommentsAt(comments, 10_000 + COMMENT_HOLD_MS - 1).map((c) => c.id),
    ).toEqual(["1"]);
    expect(activeCommentsAt(comments, 10_000 + COMMENT_HOLD_MS)).toEqual([]);
    expect(latestActiveComment(comments, 20_500)?.id).toBe("2");
  });

  test("currentCommentIndex tracks last started cue", () => {
    const comments = normalizeReviewComments([
      { id: "1", offset_ms: 0, body: "a" },
      { id: "2", offset_ms: 3000, body: "b" },
      { id: "3", offset_ms: 9000, body: "c" },
    ]);
    expect(currentCommentIndex(comments, -1)).toBe(0);
    expect(currentCommentIndex(comments, 0)).toBe(0);
    expect(currentCommentIndex(comments, 2999)).toBe(0);
    expect(currentCommentIndex(comments, 3000)).toBe(1);
    expect(currentCommentIndex(comments, 50_000)).toBe(2);
  });
});
