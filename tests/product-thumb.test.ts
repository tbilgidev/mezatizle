import { describe, expect, test } from "bun:test";
import { pickFrameIndexForOffset } from "../apps/api/src/modules/auction_pipeline.ts";

describe("pickFrameIndexForOffset", () => {
  test("maps long-live offsets across sparse 200-frame bank (not OCR_FPS=1)", () => {
    const durationSeconds = 11_123;
    const frameCount = 200;
    // Mid-live (~1h) must not clamp to last frame
    const mid = pickFrameIndexForOffset({
      offsetMs: 3_600_000,
      frameCount,
      durationSeconds,
    });
    expect(mid).toBeGreaterThan(20);
    expect(mid).toBeLessThan(180);

    const late = pickFrameIndexForOffset({
      offsetMs: 10_000_000,
      frameCount,
      durationSeconds,
    });
    expect(late).toBeGreaterThan(150);
    expect(late).toBeLessThanOrEqual(200);

    const early = pickFrameIndexForOffset({
      offsetMs: 30_000,
      frameCount,
      durationSeconds,
    });
    expect(early).toBeLessThan(10);
  });

  test("respects explicit frameFps when provided", () => {
    // 0.02 fps → index ≈ offsetSec*0.02 + 1
    expect(
      pickFrameIndexForOffset({
        offsetMs: 50_000,
        frameCount: 200,
        frameFps: 0.02,
      }),
    ).toBe(2);
  });
});
