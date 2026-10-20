import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { probeAvSync } from "../apps/api/src/lib/ffmpeg.ts";
import {
  CAPTURE_QUALITY,
  ffmpegCaptureArgs,
  ffmpegFinalizeRemuxArgs,
} from "../apps/api/src/modules/capture_quality.ts";

const fixture = join(import.meta.dir, "../fixtures/sample-live.mp4");

describe("A/V sync invariants", () => {
  test("fixture master has aligned A/V durations", async () => {
    const sync = await probeAvSync("ffprobe", fixture, 0.35);
    expect(sync.hasVideo).toBe(true);
    expect(sync.hasAudio).toBe(true);
    expect(sync.ok).toBe(true);
    expect(sync.durationSkewSec ?? 99).toBeLessThanOrEqual(0.35);
  });

  test("defaults prefer 30fps watchable capture (not 15–20 size hack)", () => {
    expect(CAPTURE_QUALITY.fps).toBeGreaterThanOrEqual(30);
    expect(CAPTURE_QUALITY.maxHeight).toBeLessThanOrEqual(720);
    expect(CAPTURE_QUALITY.captureMovflags).toContain("empty_moov");
    expect(CAPTURE_QUALITY.finalizeMovflags).toContain("faststart");
  });

  test("capture argv uses fps filter + aresample async (not bare -r drift)", () => {
    const args = ffmpegCaptureArgs({
      ffmpegPath: "ffmpeg",
      input: { kind: "muxed", url: "https://example/live" },
      outputPath: "/tmp/out.mp4",
    });
    const joined = args.join(" ");
    expect(joined).toContain("fps=30");
    expect(joined).toContain("aresample=async=1");
    expect(joined).toContain("+genpts");
    expect(joined).toContain("frag_keyframe+empty_moov+default_base_moof");
    // Portrait-safe: cap height, not width (IG lives are often 9:16)
    expect(joined).toContain("scale=-2:'min(720,ih)'");
    expect(joined).toContain("-reconnect");
    // Avoid classic `-r` after maps without filter (common desync footgun)
    const rIdx = args.indexOf("-r");
    expect(rIdx).toBe(-1);
  });

  test("local file capture omits http reconnect options", () => {
    const args = ffmpegCaptureArgs({
      ffmpegPath: "ffmpeg",
      input: { kind: "muxed", url: "/tmp/local.mp4" },
      outputPath: "/tmp/out.mp4",
    });
    expect(args.includes("-reconnect")).toBe(false);
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

  test("finalize remux uses stream copy + faststart moov", () => {
    const args = ffmpegFinalizeRemuxArgs({
      ffmpegPath: "ffmpeg",
      inputPath: "/tmp/part.mp4",
      outputPath: "/tmp/out.mp4",
    });
    const joined = args.join(" ");
    expect(joined).toContain("-c");
    expect(joined).toContain("copy");
    expect(joined).toContain("+faststart");
    expect(args.at(-1)).toBe("/tmp/out.mp4");
  });
});
