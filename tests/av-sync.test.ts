import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { probeAvSync } from "../apps/api/src/lib/ffmpeg.ts";
import { ffmpegCaptureArgs } from "../apps/api/src/modules/capture_quality.ts";

const fixture = join(import.meta.dir, "../fixtures/sample-live.mp4");

describe("A/V sync invariants", () => {
  test("fixture master has aligned A/V durations", async () => {
    const sync = await probeAvSync("ffprobe", fixture, 0.35);
    expect(sync.hasVideo).toBe(true);
    expect(sync.hasAudio).toBe(true);
    expect(sync.ok).toBe(true);
    expect(sync.durationSkewSec ?? 99).toBeLessThanOrEqual(0.35);
  });

  test("capture argv uses fps filter + aresample async (not bare -r drift)", () => {
    const args = ffmpegCaptureArgs({
      ffmpegPath: "ffmpeg",
      input: { kind: "muxed", url: "https://example/live" },
      outputPath: "/tmp/out.mp4",
    });
    const joined = args.join(" ");
    expect(joined).toContain("fps=");
    expect(joined).toContain("aresample=async=1");
    expect(joined).toContain("+genpts");
    // Avoid classic `-r` after maps without filter (common desync footgun)
    const rIdx = args.indexOf("-r");
    expect(rIdx).toBe(-1);
  });

  test("dual-input adaptive maps video+audio into one encode", () => {
    const args = ffmpegCaptureArgs({
      ffmpegPath: "ffmpeg",
      input: {
        kind: "separate",
        videoUrl: "https://v",
        audioUrl: "https://a",
      },
      outputPath: "/tmp/out.mp4",
    });
    expect(args).toContain("-map");
    expect(args.join(" ")).toContain("0:v:0");
    expect(args.join(" ")).toContain("1:a:0");
    expect(args).toContain("-shortest");
  });
});
