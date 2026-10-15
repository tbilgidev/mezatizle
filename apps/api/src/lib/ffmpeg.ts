import { $ } from "bun";
import type { MediaProbe } from "@mezatizle/shared";
import { CAPTURE_QUALITY } from "../modules/capture_quality.ts";

export async function probeMedia(
  ffprobePath: string,
  filePath: string,
): Promise<MediaProbe> {
  const proc = Bun.spawn(
    [
      ffprobePath,
      "-v",
      "quiet",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      filePath,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`ffprobe failed: ${err}`);
  }
  const json = JSON.parse(out) as {
    format?: { duration?: string; format_name?: string };
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
    }>;
  };
  const video = json.streams?.find((s) => s.codec_type === "video");
  const audio = json.streams?.find((s) => s.codec_type === "audio");
  return {
    durationSeconds: Number(json.format?.duration ?? 0),
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    videoCodec: video?.codec_name,
    audioCodec: audio?.codec_name,
    container: json.format?.format_name?.split(",")[0],
  };
}

export type AvSyncCheck = {
  ok: boolean;
  hasVideo: boolean;
  hasAudio: boolean;
  videoDurationSec: number | null;
  audioDurationSec: number | null;
  formatDurationSec: number | null;
  videoStartSec: number | null;
  audioStartSec: number | null;
  durationSkewSec: number | null;
  startSkewSec: number | null;
  maxSkewSec: number;
  detailTr: string;
};

/**
 * Compare per-stream durations / start times on the *master* MP4.
 * Analysis timestamps (ASR/OCR/sales) assume this file's timeline.
 */
export async function probeAvSync(
  ffprobePath: string,
  filePath: string,
  maxSkewSec = CAPTURE_QUALITY.maxAvSkewSec,
): Promise<AvSyncCheck> {
  const proc = Bun.spawn(
    [
      ffprobePath,
      "-v",
      "quiet",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      filePath,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`ffprobe sync check failed: ${err}`);
  }
  const json = JSON.parse(out) as {
    format?: { duration?: string };
    streams?: Array<{
      codec_type?: string;
      duration?: string;
      start_time?: string;
    }>;
  };
  const video = json.streams?.find((s) => s.codec_type === "video");
  const audio = json.streams?.find((s) => s.codec_type === "audio");
  const videoDurationSec = video?.duration != null ? Number(video.duration) : null;
  const audioDurationSec = audio?.duration != null ? Number(audio.duration) : null;
  const formatDurationSec =
    json.format?.duration != null ? Number(json.format.duration) : null;
  const videoStartSec =
    video?.start_time != null ? Number(video.start_time) : null;
  const audioStartSec =
    audio?.start_time != null ? Number(audio.start_time) : null;

  const durationSkewSec =
    videoDurationSec != null &&
    audioDurationSec != null &&
    Number.isFinite(videoDurationSec) &&
    Number.isFinite(audioDurationSec)
      ? Math.abs(videoDurationSec - audioDurationSec)
      : null;
  const startSkewSec =
    videoStartSec != null &&
    audioStartSec != null &&
    Number.isFinite(videoStartSec) &&
    Number.isFinite(audioStartSec)
      ? Math.abs(videoStartSec - audioStartSec)
      : null;

  const hasVideo = Boolean(video);
  const hasAudio = Boolean(audio);
  let ok = hasVideo;
  let detailTr = "Video var; ses yok (ASR zayıf olabilir).";
  if (hasVideo && hasAudio) {
    const skewOk =
      (durationSkewSec == null || durationSkewSec <= maxSkewSec) &&
      (startSkewSec == null || startSkewSec <= maxSkewSec);
    ok = skewOk;
    detailTr = skewOk
      ? `A/V senkron OK (süre farkı ${(durationSkewSec ?? 0).toFixed(3)}s, start ${(startSkewSec ?? 0).toFixed(3)}s ≤ ${maxSkewSec}s).`
      : `A/V sapma uyarısı: süre Δ=${(durationSkewSec ?? NaN).toFixed(3)}s start Δ=${(startSkewSec ?? NaN).toFixed(3)}s (eşik ${maxSkewSec}s). Analiz kayabilir.`;
  } else if (!hasVideo) {
    ok = false;
    detailTr = "Videostream yok — master geçersiz.";
  }

  return {
    ok,
    hasVideo,
    hasAudio,
    videoDurationSec,
    audioDurationSec,
    formatDurationSec,
    videoStartSec,
    audioStartSec,
    durationSkewSec,
    startSkewSec,
    maxSkewSec,
    detailTr,
  };
}

/**
 * Side extracts for analysis only — never overwrite the master MP4.
 * Audio WAV + OCR JPGs share the master's timeline (ASR start_ms / frame index @ OCR_FPS).
 */
export async function extractAudioAndFrames(opts: {
  ffmpegPath: string;
  inputPath: string;
  audioOutPath: string;
  framesDir: string;
  intervalSeconds: number;
}) {
  await $`mkdir -p ${opts.framesDir}`;
  // Read-only from master; do not remux/replace recordings/*.mp4
  const audio = Bun.spawn(
    [
      opts.ffmpegPath,
      "-y",
      "-i",
      opts.inputPath,
      "-vn",
      "-acodec",
      "pcm_s16le",
      "-ar",
      "16000",
      "-ac",
      "1",
      opts.audioOutPath,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  if ((await audio.exited) !== 0) {
    throw new Error(await new Response(audio.stderr).text());
  }
  const framesPattern = `${opts.framesDir}/frame_%05d.jpg`;
  // fps filter selects by master PTS → frame_00001 @ t=0, frame_N @ (N-1)/fps
  const fpsEnv = Number(process.env.OCR_FPS ?? process.env.FRAME_FPS ?? "");
  const fps =
    Number.isFinite(fpsEnv) && fpsEnv > 0
      ? fpsEnv
      : 1 / Math.max(0.1, opts.intervalSeconds);
  const frames = Bun.spawn(
    [
      opts.ffmpegPath,
      "-y",
      "-i",
      opts.inputPath,
      "-an",
      "-vf",
      `fps=${fps}`,
      "-q:v",
      "3",
      framesPattern,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  if ((await frames.exited) !== 0) {
    throw new Error(await new Response(frames.stderr).text());
  }
}
