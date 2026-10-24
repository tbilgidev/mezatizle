import { describe, expect, test } from "bun:test";
import { pidAlive } from "../apps/api/src/modules/live_capture.ts";
import { BURN_TIMEOUT_MS } from "../apps/api/src/modules/comment_burnin.ts";
import { ffmpegBurnCommentsArgs } from "../apps/api/src/modules/comment_burnin.ts";

describe("capture stall helpers", () => {
  test("pidAlive rejects null/invalid", () => {
    expect(pidAlive(null)).toBe(false);
    expect(pidAlive(undefined)).toBe(false);
    expect(pidAlive(0)).toBe(false);
    expect(pidAlive(1)).toBe(false);
    expect(pidAlive(99999999)).toBe(false);
  });

  test("pidAlive true for this process", () => {
    expect(pidAlive(process.pid)).toBe(true);
  });

  test("burn args omit +faststart movflags", () => {
    const args = ffmpegBurnCommentsArgs({
      ffmpegPath: "ffmpeg",
      inputPath: "/in.mp4",
      assPath: "/tmp/c.ass",
      outputPath: "/out.mp4",
    });
    expect(args).not.toContain("-movflags");
    expect(args.join(" ")).not.toContain("faststart");
  });

  test("burn timeout default is several minutes", () => {
    expect(BURN_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
  });
});
