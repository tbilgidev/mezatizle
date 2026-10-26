import { describe, expect, test } from "bun:test";
import {
  COMMENT_API_POLL_MAX_MS,
  COMMENT_API_POLL_MIN_MS,
  COMMENT_BACKOFF_MAX_MS,
  COMMENT_BACKOFF_START_MS,
  COMMENT_DOM_SCRAPE_MAX_MS,
  COMMENT_DOM_SCRAPE_MIN_MS,
  catchupCommentTs,
  commentFingerprint,
  isCommentFreeze,
  jitterMs,
  nextApiPollDelayMs,
  nextCommentBackoffMs,
  nextDomScrapeDelayMs,
  ratePolicySummaryTr,
} from "../apps/api/src/modules/live_comment_capture.ts";

describe("live comment capture rate policy (ban-safe)", () => {
  test("API poll band stays in ~3–5s", () => {
    expect(COMMENT_API_POLL_MIN_MS).toBeGreaterThanOrEqual(2500);
    expect(COMMENT_API_POLL_MAX_MS).toBeLessThanOrEqual(6000);
    expect(COMMENT_API_POLL_MIN_MS).toBeLessThanOrEqual(COMMENT_API_POLL_MAX_MS);
  });

  test("DOM scrape band stays in ~8–15s (secondary, not spam)", () => {
    expect(COMMENT_DOM_SCRAPE_MIN_MS).toBeGreaterThanOrEqual(7000);
    expect(COMMENT_DOM_SCRAPE_MAX_MS).toBeLessThanOrEqual(20_000);
    expect(COMMENT_DOM_SCRAPE_MIN_MS).toBeGreaterThan(COMMENT_API_POLL_MAX_MS);
  });

  test("jitterMs stays within bounds", () => {
    for (let i = 0; i < 40; i++) {
      const v = jitterMs(3000, 5000, () => i / 40);
      expect(v).toBeGreaterThanOrEqual(3000);
      expect(v).toBeLessThanOrEqual(5000);
    }
  });

  test("nextApiPollDelayMs uses safe band; respects backoff when rate-limited", () => {
    const d = nextApiPollDelayMs({ random: () => 0.5 });
    expect(d).toBeGreaterThanOrEqual(COMMENT_API_POLL_MIN_MS);
    expect(d).toBeLessThanOrEqual(COMMENT_API_POLL_MAX_MS);
    const backed = nextApiPollDelayMs({
      rateLimited: true,
      backoffMs: 90_000,
      random: () => 0,
    });
    expect(backed).toBeGreaterThanOrEqual(90_000);
  });

  test("DOM delay is slower than API", () => {
    const api = nextApiPollDelayMs({ random: () => 0 });
    const dom = nextDomScrapeDelayMs(() => 0);
    expect(dom).toBeGreaterThan(api);
  });

  test("429 backoff grows toward auto-follow-like minutes, not sub-second hammer", () => {
    expect(COMMENT_BACKOFF_START_MS).toBeGreaterThanOrEqual(15_000);
    let b = 0;
    const steps: number[] = [];
    for (let i = 0; i < 8; i++) {
      b = nextCommentBackoffMs(b, () => 0.5);
      steps.push(b);
    }
    expect(steps[0]).toBeGreaterThanOrEqual(COMMENT_BACKOFF_START_MS * 0.85);
    expect(steps[steps.length - 1]).toBeLessThanOrEqual(COMMENT_BACKOFF_MAX_MS);
    expect(steps[steps.length - 1]).toBeGreaterThanOrEqual(60_000);
    // Never shrink early steps below start
    expect(steps[1]).toBeGreaterThan(steps[0]);
  });

  test("ratePolicySummaryTr mentions both channels", () => {
    const s = ratePolicySummaryTr();
    expect(s).toContain("API poll");
    expect(s).toContain("DOM scrape");
    expect(s).toContain("backoff");
  });
});

describe("freeze + catchup + fingerprint", () => {
  test("isCommentFreeze false inside first window", () => {
    const t0 = 1_000_000;
    expect(isCommentFreeze(t0, t0 + 60_000, { freezeMinutes: 3 })).toBe(false);
  });

  test("isCommentFreeze true after threshold without hits", () => {
    const t0 = 1_000_000;
    expect(isCommentFreeze(t0, t0 + 3 * 60_000, { freezeMinutes: 3 })).toBe(
      true,
    );
  });

  test("catchupCommentTs rewinds but not below now-rewind", () => {
    const now = 1_700_000_000;
    const floor = now - 120;
    expect(catchupCommentTs(0, now, 120)).toBe(floor);
    // recent cursor → rewind by 120s (still ≥ floor)
    expect(catchupCommentTs(now + 50, now, 120)).toBe(now + 50 - 120);
    // old cursor → clamp up to floor so we always cover the recent window
    expect(catchupCommentTs(now - 10_000, now, 120)).toBe(floor);
  });

  test("commentFingerprint stable within bucket, differs across users", () => {
    const a = commentFingerprint({
      username: "Ali",
      text: "  Aldım  ",
      createdAtMs: 12_000,
      bucketMs: 5000,
    });
    const b = commentFingerprint({
      username: "ali",
      text: "aldım",
      createdAtMs: 14_000,
      bucketMs: 5000,
    });
    const c = commentFingerprint({
      username: "veli",
      text: "aldım",
      createdAtMs: 12_000,
      bucketMs: 5000,
    });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});
