/**
 * Live capture defaults — watchable master for humans + ASR/OCR.
 *
 * SIZE: scale (≤720p) + CRF/maxrate — never starve FPS for smaller files.
 * FPS: steady CFR ~30 (source lives are typically 30). Do not use 15–20 as a
 *      size hack; dropped frames make speech/comments unwatchable and desync.
 * A/V: one muxed encode clock; aresample=async + genpts; no bare `-r` drift.
 * MOOV: fragmented MP4 during capture so forced stops stay readable; remux to
 *       progressive +faststart on finalize.
 *
 * OCR 1fps frames are a *side extract* from the finished master — they must
 * not rewrite the master file.
 */
export const CAPTURE_QUALITY = {
  /** Cap output height (scale down only; never upscale). */
  maxHeight: Number(process.env.LIVE_MAX_HEIGHT ?? "720"),
  /**
   * Steady full-rate CFR. Prefer 30 when source is ~30.
   * Override with LIVE_FPS only for deliberate experiments — not for size.
   */
  fps: Number(process.env.LIVE_FPS ?? "30"),
  /** x264 CRF — size lever (higher = smaller). 23–28 stays watchable. */
  crf: Number(process.env.LIVE_CRF ?? "26"),
  /** Soft bitrate cap (kbps video) — size lever with CRF. */
  maxrateKbps: Number(process.env.LIVE_MAXRATE_K ?? "2500"),
  /** AAC audio bitrate (kbps) — speech clarity for ASR / lip-sync check. */
  audioKbps: Number(process.env.LIVE_AUDIO_K ?? "96"),
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
  /**
   * During capture: fragmented MP4 so SIGTERM / max-duration kills still leave
   * a playable file (moov/headers present). Finalize remuxes to +faststart.
   */
  captureMovflags:
    process.env.LIVE_CAPTURE_MOVFLAGS ??
    "frag_keyframe+empty_moov+default_base_moof",
  finalizeMovflags: process.env.LIVE_FINALIZE_MOVFLAGS ?? "+faststart",
  rationaleTr:
    "Varsayılan: ≤720p, 30 fps (fps filtresi, kare atmadan), H.264 CRF 26 / ~2.5 Mbps tavan, AAC 96 kbps mono. Boyut çözünürlük+CRF ile; A/V aynı encode zaman çizelgesi (aresample=async, +genpts). Kayıt sırası fragmented MP4; bitişte faststart remux. OCR 1 fps ayrı çıkarım.",
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
  // Cap *height* to maxHeight (720p). Portrait IG lives are taller than wide —
  // using min(H,iw):-2 left 720×1280 untouched and blew past "720p".
  // fps in the filter (not bare -r) keeps PTS coherent with audio from same run.
  const vf = `scale=-2:'min(${q.maxHeight},ih)',fps=${q.fps}`;
  const af = "aresample=async=1:first_pts=0";

  const args: string[] = [
    opts.ffmpegPath,
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-fflags",
    "+genpts",
  ];

  const remoteUrls =
    opts.input.kind === "muxed"
      ? [opts.input.url]
      : [opts.input.videoUrl, opts.input.audioUrl];
  // reconnect* is http(s) only — local file probes fail with "Option reconnect not found"
  if (remoteUrls.some((u) => /^https?:\/\//i.test(u))) {
    args.push(
      "-reconnect",
      "1",
      "-reconnect_streamed",
      "1",
      "-reconnect_delay_max",
      "15",
    );
  }

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
    "-g",
    String(Math.max(1, Math.round(q.fps * 2))), // ~2s keyframe → frag_keyframe friendly
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
    q.captureMovflags,
    "-avoid_negative_ts",
    "make_zero",
  );

  if (opts.maxDurationSeconds && opts.maxDurationSeconds > 0) {
    args.push("-t", String(opts.maxDurationSeconds));
  }
  args.push(opts.outputPath);
  return args;
}

/**
 * Remux fragmented/partial capture → progressive MP4 with moov for players.
 * Copy codecs only (no re-encode). Used on stop / max-duration finalize.
 */
export function ffmpegFinalizeRemuxArgs(opts: {
  ffmpegPath: string;
  inputPath: string;
  outputPath: string;
}): string[] {
  const q = CAPTURE_QUALITY;
  return [
    opts.ffmpegPath,
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    opts.inputPath,
    "-c",
    "copy",
    "-movflags",
    q.finalizeMovflags,
    opts.outputPath,
  ];
}
