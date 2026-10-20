/**
 * Self-test capture argv + moov finalize remux without a real IG live.
 *
 * 1) Assert ffmpegCaptureArgs: 30fps filter, aresample, frag movflags (no bare -r)
 * 2) Encode a short synthetic muxed clip with those args (color+sine)
 * 3) SIGTERM-style stop is simulated by -t; remux with finalize args
 * 4) ffprobe: readable MP4, A/V present, fps≈30, skew OK
 *
 * Usage: bun scripts/verify-capture-pipeline.ts
 */
import { mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { probeAvSync } from "../apps/api/src/lib/ffmpeg.ts";
import {
  CAPTURE_QUALITY,
  ffmpegCaptureArgs,
  ffmpegFinalizeRemuxArgs,
} from "../apps/api/src/modules/capture_quality.ts";

const ROOT = join(import.meta.dir, "..");
const OUT_DIR = join(ROOT, "storage", "tmp-capture-verify");
const PART = join(OUT_DIR, "verify.part.mp4");
const FINAL = join(OUT_DIR, "verify.mp4");
const SRC = join(OUT_DIR, "src-muxed.mp4");

async function run(argv: string[]): Promise<{ code: number; stderr: string }> {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { code, stderr };
}

async function main() {
  console.log("[verify-capture] quality", {
    fps: CAPTURE_QUALITY.fps,
    maxHeight: CAPTURE_QUALITY.maxHeight,
    crf: CAPTURE_QUALITY.crf,
    audioKbps: CAPTURE_QUALITY.audioKbps,
    captureMovflags: CAPTURE_QUALITY.captureMovflags,
  });
  if (CAPTURE_QUALITY.fps < 30) {
    throw new Error(`LIVE_FPS must be >= 30 for watchable capture (got ${CAPTURE_QUALITY.fps})`);
  }

  const sampleArgs = ffmpegCaptureArgs({
    ffmpegPath: "ffmpeg",
    input: { kind: "muxed", url: "https://example.invalid/live" },
    outputPath: "/tmp/out.mp4",
    maxDurationSeconds: 15,
  });
  const joined = sampleArgs.join(" ");
  for (const must of [
    "fps=30",
    "aresample=async=1",
    "+genpts",
    "frag_keyframe+empty_moov+default_base_moof",
  ]) {
    if (!joined.includes(must)) {
      throw new Error(`capture argv missing ${must}: ${joined}`);
    }
  }
  if (sampleArgs.includes("-r")) {
    throw new Error("capture argv must not use bare -r");
  }
  console.log("[verify-capture] argv OK");

  await mkdir(OUT_DIR, { recursive: true });
  for (const p of [PART, FINAL, SRC]) {
    try {
      await unlink(p);
    } catch {
      /* ignore */
    }
  }

  // Synthetic 30fps muxed source (~3s) — stands in for IG DASH
  const srcCode = await run([
    "ffmpeg",
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=720x1280:rate=30",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=880:sample_rate=44100",
    "-t",
    "3",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-shortest",
    SRC,
  ]);
  if (srcCode.code !== 0) {
    throw new Error(`src encode failed: ${srcCode.stderr}`);
  }

  const captureArgv = ffmpegCaptureArgs({
    ffmpegPath: "ffmpeg",
    input: { kind: "muxed", url: SRC },
    outputPath: PART,
    maxDurationSeconds: 2,
  });
  const cap = await run(captureArgv);
  if (cap.code !== 0) {
    throw new Error(`capture encode failed: ${cap.stderr}`);
  }

  const remuxArgv = ffmpegFinalizeRemuxArgs({
    ffmpegPath: "ffmpeg",
    inputPath: PART,
    outputPath: FINAL,
  });
  const remux = await run(remuxArgv);
  if (remux.code !== 0) {
    throw new Error(`finalize remux failed: ${remux.stderr}`);
  }

  const sync = await probeAvSync("ffprobe", FINAL, CAPTURE_QUALITY.maxAvSkewSec);
  if (!sync.ok || !sync.hasAudio || !sync.hasVideo) {
    throw new Error(`A/V sync failed: ${JSON.stringify(sync)}`);
  }

  const probe = Bun.spawn(
    [
      "ffprobe",
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=avg_frame_rate,r_frame_rate,width,height",
      "-of",
      "json",
      FINAL,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const probeOut = JSON.parse(await new Response(probe.stdout).text()) as {
    streams?: Array<{ avg_frame_rate?: string; width?: number; height?: number }>;
  };
  await probe.exited;
  const stream = probeOut.streams?.[0];
  const avg = stream?.avg_frame_rate ?? "0/1";
  const [num, den] = avg.split("/").map(Number);
  const fps = den ? num / den : 0;
  if (fps < 28 || fps > 32) {
    throw new Error(`expected ~30fps master, got ${avg} (${fps})`);
  }
  if ((stream?.height ?? 0) > CAPTURE_QUALITY.maxHeight) {
    throw new Error(`height ${stream?.height} exceeds maxHeight`);
  }

  console.log("[verify-capture] OK", {
    fps: avg,
    width: stream?.width,
    height: stream?.height,
    sync: sync.detailTr,
    final: FINAL,
  });
}

main().catch((err) => {
  console.error("[verify-capture] FAIL", err);
  process.exit(1);
});
