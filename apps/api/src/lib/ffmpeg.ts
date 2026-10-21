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

/** Heartbeat while a long ffmpeg child runs (keeps analysis watchdog from reclaiming). */
async function runFfmpegWithHeartbeat(
  args: string[],
  onHeartbeat?: () => void | Promise<void>,
  heartbeatMs = 25_000,
): Promise<{ code: number; stderr: string }> {
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  let stderr = "";
  const stderrTask = new Response(proc.stderr).text().then((t) => {
    stderr = t;
  });
  const hb = onHeartbeat
    ? setInterval(() => {
        void Promise.resolve(onHeartbeat()).catch(() => {});
      }, heartbeatMs)
    : null;
  try {
    const code = await proc.exited;
    await stderrTask;
    return { code, stderr };
  } finally {
    if (hb) clearInterval(hb);
  }
}

/**
 * Frame sampling rate for OCR side-extracts.
 * Cap by OCR_MAX_FRAMES / duration so a 3–4h live does not dump 10k+ JPEGs.
 */
export function analysisFrameFps(opts: {
  intervalSeconds: number;
  durationSeconds?: number | null;
  maxFrames?: number;
}): number {
  const maxFrames = Math.max(
    1,
    opts.maxFrames ??
      Number(process.env.OCR_MAX_FRAMES ?? process.env.OCR_MAX_FRAME ?? "200"),
  );
  const fpsEnv = Number(process.env.OCR_FPS ?? process.env.FRAME_FPS ?? "");
  let fps =
    Number.isFinite(fpsEnv) && fpsEnv > 0
      ? fpsEnv
      : 1 / Math.max(0.1, opts.intervalSeconds);
  const dur = Number(opts.durationSeconds ?? 0);
  if (Number.isFinite(dur) && dur > 60) {
    const capped = maxFrames / dur;
    // Keep at least ~1 frame / 10 min so late lots still get a still.
    fps = Math.min(fps, Math.max(1 / 600, capped));
  }
  return fps;
}

function truncateErr(stderr: string, max = 1200): string {
  const t = stderr.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, 400)}\n…\n${t.slice(-800)}`;
}

/**
 * Side extracts for analysis only — never overwrite the master MP4.
 * Audio WAV + OCR JPGs share the master's timeline (ASR start_ms / frame index @ fps).
 *
 * Live DASH masters often have mid-stream AAC corruption. We:
 * - discard corrupt packets / force mono via pan (avoids SWR 23ch rematrix crash)
 * - accept a substantial partial WAV when ffmpeg still exits non-zero
 */
export async function extractAudioAndFrames(opts: {
  ffmpegPath: string;
  ffprobePath?: string;
  inputPath: string;
  audioOutPath: string;
  framesDir: string;
  intervalSeconds: number;
  durationSeconds?: number | null;
  onHeartbeat?: () => void | Promise<void>;
}): Promise<{
  audioPartial: boolean;
  audioDurationSec: number;
  frameFps: number;
}> {
  await $`mkdir -p ${opts.framesDir}`;
  const expectedDur = Number(opts.durationSeconds ?? 0);
  const audioArgs = [
    opts.ffmpegPath,
    "-y",
    "-err_detect",
    "ignore_err",
    "-fflags",
    "+discardcorrupt+genpts",
    "-i",
    opts.inputPath,
    "-vn",
    "-map",
    "0:a:0",
    // pan first channel → mono: survives corrupt AAC "N channels" glitches
    "-af",
    "pan=mono|c0=c0,aresample=16000,aformat=sample_fmts=s16:channel_layouts=mono",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-acodec",
    "pcm_s16le",
    opts.audioOutPath,
  ];
  const audio = await runFfmpegWithHeartbeat(audioArgs, opts.onHeartbeat);
  const probePath = opts.ffprobePath ?? "ffprobe";
  let audioDurationSec = 0;
  try {
    const probed = await probeMedia(probePath, opts.audioOutPath);
    audioDurationSec = Number(probed.durationSeconds ?? 0);
  } catch {
    audioDurationSec = 0;
  }
  const minAcceptSec = Math.max(
    120,
    Number.isFinite(expectedDur) && expectedDur > 0
      ? expectedDur * 0.35
      : 120,
  );
  const audioPartial = audio.code !== 0;
  if (audio.code !== 0 && audioDurationSec < minAcceptSec) {
    throw new Error(
      `audio extract failed (wav=${audioDurationSec.toFixed(1)}s < ${minAcceptSec.toFixed(0)}s): ${truncateErr(audio.stderr)}`,
    );
  }

  const frameFps = analysisFrameFps({
    intervalSeconds: opts.intervalSeconds,
    durationSeconds:
      Number.isFinite(expectedDur) && expectedDur > 0
        ? expectedDur
        : audioDurationSec || null,
  });
  const framesPattern = `${opts.framesDir}/frame_%05d.jpg`;
  const framesArgs = [
    opts.ffmpegPath,
    "-y",
    "-err_detect",
    "ignore_err",
    "-fflags",
    "+discardcorrupt+genpts",
    "-i",
    opts.inputPath,
    "-an",
    "-vf",
    `fps=${frameFps}`,
    "-q:v",
    "5",
    framesPattern,
  ];
  const frames = await runFfmpegWithHeartbeat(framesArgs, opts.onHeartbeat);
  const frameGlob = Array.from(
    new Bun.Glob("*.jpg").scanSync({ cwd: opts.framesDir }),
  );
  if (frames.code !== 0 && frameGlob.length < 3) {
    throw new Error(
      `frame extract failed (frames=${frameGlob.length}): ${truncateErr(frames.stderr)}`,
    );
  }

  return { audioPartial, audioDurationSec, frameFps };
}
