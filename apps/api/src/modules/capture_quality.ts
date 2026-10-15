/**
 * Compact-but-analyzable live capture defaults.
 * Goal: keep ASR (speech), OCR (comments/overlays), and product frames usable
 * without multi‑GB files for long Instagram lives.
 *
 * A/V SYNC INVARIANT (master recording):
 * - One muxed MP4; audio+video share the same timeline (PTS from one encode).
 * - Never process A/V on separate clocks then stitch blindly.
 * - Lower fps (e.g. 20) via the fps *filter* on video while audio is re-encoded
 *   from the same input with aresample=async so slight drift is corrected.
 * - OCR 1fps frames are a *side extract* from the finished master — they must
 *   not rewrite the master file.
 */
export const CAPTURE_QUALITY = {
  /** Cap output height (scale down only). */
  maxHeight: Number(process.env.LIVE_MAX_HEIGHT ?? "720"),
  /** Target fps for long lives (analysis does not need 30/60). */
  fps: Number(process.env.LIVE_FPS ?? "20"),
  /** x264 CRF — higher = smaller; 26–30 still OK for OCR/ASR. */
  crf: Number(process.env.LIVE_CRF ?? "28"),
  /** Soft bitrate cap (kbps video). */
  maxrateKbps: Number(process.env.LIVE_MAXRATE_K ?? "1800"),
  /** AAC audio bitrate (kbps). */
  audioKbps: Number(process.env.LIVE_AUDIO_K ?? "80"),
  /** Mono is enough for speech ASR. */
  audioChannels: 1,
  /**
   * yt-dlp format: prefer single progressive ≤720p (one URL = already muxed).
   * Fallback adaptive video+audio (two URLs → ffmpeg dual-input mux).
   */
  ytdlpFormat:
    process.env.LIVE_YTDLP_FORMAT ??
    "best[height<=720][protocol^=http][protocol!*=m3u8]/best[height<=720]/bestvideo[height<=720]+bestaudio/best",
  preset: process.env.LIVE_X264_PRESET ?? "veryfast",
  /** Max |audioDur − videoDur| (seconds) before sync check warns. */
  maxAvSkewSec: Number(process.env.LIVE_MAX_AV_SKEW_SEC ?? "0.35"),
  rationaleTr:
    "Varsayılan: en fazla 720p, ~20 fps (fps filtresi), H.264 CRF 28, AAC 80 kbps mono — A/V aynı encode zaman çizelgesinde. OCR 1 fps ayrı çıkarım; master dosyayı bozmaz.",
} as const;

export type CaptureInput =
  | { kind: "muxed"; url: string }
  | { kind: "separate"; videoUrl: string; audioUrl: string };

/**
 * Build ffmpeg argv for a sync-safe master capture.
 * Dual-URL adaptive streams are muxed in one process (shared encode clock).
 */
export function ffmpegCaptureArgs(opts: {
  ffmpegPath: string;
  input: CaptureInput;
  outputPath: string;
  maxDurationSeconds?: number | null;
}): string[] {
  const q = CAPTURE_QUALITY;
  // fps in the filter (not bare -r) keeps PTS coherent with audio from same run
  const vf = `scale='min(${q.maxHeight},iw)':-2,fps=${q.fps}`;
  const af = "aresample=async=1:first_pts=0";

  const args: string[] = [
    opts.ffmpegPath,
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-fflags",
    "+genpts",
    "-reconnect",
    "1",
    "-reconnect_streamed",
    "1",
    "-reconnect_delay_max",
    "15",
  ];

  if (opts.input.kind === "muxed") {
    args.push("-i", opts.input.url);
    args.push("-map", "0:v:0", "-map", "0:a:0?");
  } else {
    // Separate adaptive URLs — still one ffmpeg process, one output timeline
    args.push("-i", opts.input.videoUrl, "-i", opts.input.audioUrl);
    args.push("-map", "0:v:0", "-map", "1:a:0");
  }

  args.push(
    "-c:v",
    "libx264",
    "-preset",
    q.preset,
    "-crf",
    String(q.crf),
    "-maxrate",
    `${q.maxrateKbps}k`,
    "-bufsize",
    `${q.maxrateKbps * 2}k`,
    "-vf",
    vf,
    "-fps_mode",
    "cfr",
    "-c:a",
    "aac",
    "-b:a",
    `${q.audioKbps}k`,
    "-ac",
    String(q.audioChannels),
    "-af",
    af,
    "-shortest", // if dual-input ends unevenly, stop together (avoid runaway drift)
    "-movflags",
    "+faststart",
    "-avoid_negative_ts",
    "make_zero",
  );

  if (opts.maxDurationSeconds && opts.maxDurationSeconds > 0) {
    args.push("-t", String(opts.maxDurationSeconds));
  }
  args.push(opts.outputPath);
  return args;
}
