import { $ } from "bun";
import type { MediaProbe } from "@mezatizle/shared";

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

export async function extractAudioAndFrames(opts: {
  ffmpegPath: string;
  inputPath: string;
  audioOutPath: string;
  framesDir: string;
  intervalSeconds: number;
}) {
  await $`mkdir -p ${opts.framesDir}`;
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
  // Prefer explicit fps (OCR_FPS / FRAME_FPS); else 1/intervalSeconds
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
