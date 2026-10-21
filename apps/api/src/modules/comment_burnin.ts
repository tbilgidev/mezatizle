/**
 * Time-aligned comment HUD burn-in for live masters.
 *
 * DASH ffmpeg capture has no IG comment UI. We persist live_api text to
 * observed_comments AND append ASS cues → on finalize, one re-encode burns
 * the strip into the MP4 so Video open shows comments in-frame.
 *
 * Soft ASS sidecar stays next to the master for debugging; burn is best-effort
 * (never fails the A/V finalize if burn fails).
 */
import { appendFile, mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import {
  CAPTURE_QUALITY,
} from "./capture_quality.ts";

const CUE_HOLD_SEC = 8;

export function msToAssTime(ms: number): string {
  const clamped = Math.max(0, Math.floor(ms));
  const h = Math.floor(clamped / 3_600_000);
  const m = Math.floor((clamped % 3_600_000) / 60_000);
  const s = Math.floor((clamped % 60_000) / 1000);
  const cs = Math.floor((clamped % 1000) / 10);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

export function escapeAssText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}")
    .replace(/\r?\n/g, " ")
    .slice(0, 180);
}

export function assHeader(): string {
  return `[Script Info]
ScriptType: v4.00+
PlayResX: 1280
PlayResY: 720
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: CommentHUD,DejaVu Sans,22,&H00FFFFFF,&H000000FF,&H80000000,&H80000000,0,0,0,0,100,100,0,0,3,2,0,1,24,24,48,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
}

export function assDialogueLine(opts: {
  offsetMs: number;
  username: string | null;
  text: string;
  holdSec?: number;
}): string {
  const hold = (opts.holdSec ?? CUE_HOLD_SEC) * 1000;
  const start = msToAssTime(opts.offsetMs);
  const end = msToAssTime(opts.offsetMs + hold);
  const who = opts.username ? `@${opts.username}` : "?";
  const body = escapeAssText(opts.text);
  return `Dialogue: 0,${start},${end},CommentHUD,,0,0,0,,{\\b1}${who}{\\b0}: ${body}\n`;
}

export function commentsAssPath(masterMp4Abs: string): string {
  return masterMp4Abs.replace(/\.mp4$/i, "") + ".comments.ass";
}

/** Ensure ASS file exists with header (idempotent). */
export async function ensureCommentsAssFile(assPath: string): Promise<void> {
  await mkdir(dirname(assPath), { recursive: true });
  try {
    const existing = await readFile(assPath, "utf8");
    if (existing.includes("[Events]")) return;
  } catch {
    /* create */
  }
  await writeFile(assPath, assHeader(), "utf8");
}

export async function appendCommentAssCue(
  assPath: string,
  cue: { offsetMs: number; username: string | null; text: string },
): Promise<void> {
  await ensureCommentsAssFile(assPath);
  await appendFile(assPath, assDialogueLine(cue), "utf8");
}

/** True when ASS has at least one Dialogue cue. */
export async function assHasCues(assPath: string): Promise<boolean> {
  try {
    const text = await readFile(assPath, "utf8");
    return /^Dialogue:/m.test(text);
  } catch {
    return false;
  }
}

/** Escape path for ffmpeg subtitles= filter (Linux). */
export function escapeSubtitlesFilterPath(absPath: string): string {
  return absPath
    .replace(/\\/g, "/")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]");
}

/**
 * Re-encode video with burned ASS HUD; copy audio to preserve A/V sync.
 * Same ≤720 already in master — we do not re-scale; keep CRF/maxrate.
 */
export function ffmpegBurnCommentsArgs(opts: {
  ffmpegPath: string;
  inputPath: string;
  assPath: string;
  outputPath: string;
}): string[] {
  const q = CAPTURE_QUALITY;
  const assEsc = escapeSubtitlesFilterPath(opts.assPath);
  return [
    opts.ffmpegPath,
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    opts.inputPath,
    "-vf",
    `subtitles=${assEsc}`,
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
    "-c:a",
    "copy",
    // No +faststart here — second-pass moov shift has hung finalize (glam burn.tmp).
    "-avoid_negative_ts",
    "make_zero",
    opts.outputPath,
  ];
}

/** Soft cap so a hung burn never blocks the live supervisor tick (glam/8e6f class). */
export const BURN_TIMEOUT_MS = Number(
  process.env.LIVE_BURN_TIMEOUT_MS ?? String(8 * 60_000),
);

export async function burnCommentsIntoMaster(opts: {
  ffmpegPath: string;
  masterAbs: string;
  assPath?: string;
  timeoutMs?: number;
}): Promise<{ ok: boolean; burned: boolean; detail: string }> {
  const assPath = opts.assPath ?? commentsAssPath(opts.masterAbs);
  if (!(await assHasCues(assPath))) {
    return { ok: true, burned: false, detail: "no_ass_cues" };
  }
  const tmpAbs = `${opts.masterAbs}.burn.tmp.mp4`;
  const args = ffmpegBurnCommentsArgs({
    ffmpegPath: opts.ffmpegPath,
    inputPath: opts.masterAbs,
    assPath,
    outputPath: tmpAbs,
  });
  const timeoutMs = opts.timeoutMs ?? BURN_TIMEOUT_MS;
  let proc: ReturnType<typeof Bun.spawn> | null = null;
  try {
    proc = Bun.spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });
    const stderrPromise = new Response(proc.stderr).text();
    const exitPromise = proc.exited;
    let timedOut = false;
    const timeoutPromise = new Promise<number>((resolve) => {
      setTimeout(() => {
        timedOut = true;
        try {
          proc?.kill();
        } catch {
          /* ignore */
        }
        resolve(-1);
      }, Math.max(5_000, timeoutMs));
    });
    const exitCode = await Promise.race([exitPromise, timeoutPromise]);
    const stderrText = await Promise.race([
      stderrPromise,
      Bun.sleep(2_000).then(() => ""),
    ]);
    if (timedOut || exitCode === -1) {
      try {
        await unlink(tmpAbs);
      } catch {
        /* ignore */
      }
      return {
        ok: false,
        burned: false,
        detail: `burn_timeout_${Math.round(timeoutMs / 1000)}s`,
      };
    }
    if (exitCode !== 0) {
      try {
        await unlink(tmpAbs);
      } catch {
        /* ignore */
      }
      return {
        ok: false,
        burned: false,
        detail: `burn exit ${exitCode}: ${stderrText.slice(0, 200)}`,
      };
    }
    await rename(tmpAbs, opts.masterAbs);
    return { ok: true, burned: true, detail: "burned_ass_hud" };
  } catch (err) {
    try {
      proc?.kill();
    } catch {
      /* ignore */
    }
    try {
      await unlink(tmpAbs);
    } catch {
      /* ignore */
    }
    return {
      ok: false,
      burned: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Minutes of kaydediliyor before we shout about 0 live_api comments. */
export const COMMENT_DROUGHT_MINUTES = Number(
  process.env.LIVE_COMMENT_DROUGHT_MIN ?? "2",
);
