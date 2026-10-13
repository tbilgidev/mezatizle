/**
 * Compact-but-analyzable live capture defaults.
 * Goal: keep ASR (speech), OCR (comments/overlays), and product frames usable
 * without multi‑GB files for long Instagram lives.
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
  /** yt-dlp format: prefer ≤720p progressive/adaptive. */
  ytdlpFormat:
    process.env.LIVE_YTDLP_FORMAT ??
    "best[height<=720]/bestvideo[height<=720]+bestaudio/best",
  preset: process.env.LIVE_X264_PRESET ?? "veryfast",
  rationaleTr:
    "Varsayılan: en fazla 720p, ~20 fps, H.264 CRF 28 (~1.8 Mbps tavan), AAC 80 kbps mono. Konuşma ASR + yorum/ürün OCR için yeterli; uzun yayınlarda disk şişmesini sınırlar.",
} as const;

export function ffmpegCaptureArgs(opts: {
  ffmpegPath: string;
  inputUrl: string;
  outputPath: string;
  maxDurationSeconds?: number | null;
}): string[] {
  const q = CAPTURE_QUALITY;
  const vf = `scale='min(${q.maxHeight},iw)':-2`;
  const args = [
    opts.ffmpegPath,
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-reconnect",
    "1",
    "-reconnect_streamed",
    "1",
    "-reconnect_delay_max",
    "15",
    "-i",
    opts.inputUrl,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
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
    "-r",
    String(q.fps),
    "-vf",
    vf,
    "-c:a",
    "aac",
    "-b:a",
    `${q.audioKbps}k`,
    "-ac",
    String(q.audioChannels),
    "-movflags",
    "+faststart",
  ];
  if (opts.maxDurationSeconds && opts.maxDurationSeconds > 0) {
    args.push("-t", String(opts.maxDurationSeconds));
  }
  args.push(opts.outputPath);
  return args;
}
