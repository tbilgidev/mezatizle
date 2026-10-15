/**
 * Module H — Live capture via yt-dlp/ffmpeg.
 *
 * Operator may supply their own backup Instagram session under
 * Ayarlar → Instagram oturumu (cookies preferred). No private API,
 * no anti-bot kits — only the session the operator provides.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, stat, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { Sql } from "@mezatizle/db";
import { parseLiveSourceInput } from "@mezatizle/shared";
import type { AppEnv } from "../lib/env.ts";
import { safeJoinStorage, toStorageKey } from "../lib/storage.ts";
import { enqueueAnalysisPipeline, upsertSeller } from "./ingestion.ts";
import {
  resolveCookiesPath,
  setIgSessionLastError,
  ytDlpAuthArgs,
} from "./ig_session.ts";
import {
  CAPTURE_QUALITY,
  ffmpegCaptureArgs,
  type CaptureInput,
} from "./capture_quality.ts";
import { probeAvSync } from "../lib/ffmpeg.ts";
import {
  extractBroadcastIdFromUrl,
  resolveLiveStreamWithPlaywright,
  usernameFromWatchUrl,
} from "./ig_live_playwright.ts";
import { access } from "node:fs/promises";
import { resolve } from "node:path";

export const LIVE_CAPTURE_POLICY = {
  status: "operator_session_optional" as const,
  playwright: "login_export_cookies_and_live_resolve",
  tools: ["yt-dlp", "ffmpeg", "playwright"],
  message:
    "Canlı kayıt: yt-dlp denemesi + Playwright+çerez ile yayın/DASH çözümleme, ffmpeg encode. Giriş: Ayarlar → Instagram oturumu (yedek hesap). Özel API / bot aşımı yok.",
  restrictions: [
    "Özel / belgesiz Instagram API yok",
    "Anti-bot aşımı / CAPTCHA bypass yok",
    "Yalnızca operatörün verdiği yedek hesap oturumu (cookies veya kullanıcı/parola)",
    "Kayıt için yasal/izin yükümlülüğü operatörde",
  ],
  limitationTr:
    "Instagram canlıları çoğu zaman oturum ister (tarayıcıda izlenebilir olsa bile). cookies.txt / Playwright oturumu zorunlu sayılır. yt-dlp’nin Instagram Live çıkarıcısı yok; Playwright DASH çözümler.",
  settingsPathTr: "Ayarlar → Instagram oturumu (yedek hesap)",
};

const activeProcs = new Map<string, ChildProcessWithoutNullStreams>();
let loopStarted = false;

/** Prefer project venv yt-dlp (current) over stale distro package. */
function ytDlpBin(): string {
  if (process.env.YT_DLP_PATH?.trim()) return process.env.YT_DLP_PATH.trim();
  const venv = resolve(process.cwd(), ".venv/bin/yt-dlp");
  return venv;
}

async function ytDlpBinResolved(): Promise<string> {
  const preferred = ytDlpBin();
  try {
    await access(preferred);
    return preferred;
  } catch {
    /* fall through */
  }
  const venv = resolve(process.cwd(), ".venv/bin/yt-dlp");
  try {
    await access(venv);
    return venv;
  } catch {
    return "yt-dlp";
  }
}

function maxLiveBytes(env: AppEnv) {
  return Number(process.env.MAX_LIVE_BYTES ?? env.maxUploadBytes * 4);
}

function probeIntervalMs() {
  return Number(process.env.LIVE_PROBE_INTERVAL_MS ?? "20000");
}

function maxWaitMs() {
  return Number(process.env.LIVE_MAX_WAIT_MS ?? String(6 * 60 * 60 * 1000));
}

async function runCapture(
  argv: string[],
  timeoutMs: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PYTHONWARNINGS: "ignore" },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      stdout += String(d);
      if (stdout.length > 200_000) stdout = stdout.slice(-100_000);
    });
    child.stderr.on("data", (d) => {
      stderr += String(d);
      if (stderr.length > 200_000) stderr = stderr.slice(-100_000);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: String(err) });
    });
  });
}

type ProbeResult =
  | { ok: true; detail: string; streamUrl?: string }
  | {
      ok: false;
      kind: "blocked" | "not_found" | "rate_limited" | "error";
      detail: string;
    };

function classifyYtDlpProbeFailure(
  code: number,
  stdout: string,
  stderr: string,
  hasCookies: boolean,
): ProbeResult | null {
  const blob = `${stdout}\n${stderr}`;
  const low = blob.toLowerCase();

  if (code === 0 && stdout.trim().startsWith("{")) {
    try {
      const j = JSON.parse(stdout) as {
        is_live?: boolean;
        formats?: unknown[];
      };
      if (j.is_live || (j.formats && j.formats.length > 0)) {
        return { ok: true, detail: "ytdlp_stream_metadata_ok" };
      }
    } catch {
      /* fall through */
    }
  }

  if (
    low.includes("http error 429") ||
    low.includes("too many requests") ||
    low.includes("rate-limit")
  ) {
    return {
      ok: false,
      kind: "rate_limited",
      detail:
        "yt-dlp: Instagram HTTP 429 (rate-limit). Playwright+çerez ile denenecek / sonra tekrar.",
    };
  }

  if (
    low.includes("login required") ||
    low.includes("please log in") ||
    low.includes("sign in") ||
    low.includes("http error 401") ||
    low.includes("http error 403") ||
    low.includes("checkpoint") ||
    low.includes("session expired") ||
    low.includes("not authorized") ||
    (low.includes("cookie") &&
      (low.includes("expired") || low.includes("invalid")))
  ) {
    return {
      ok: false,
      kind: "blocked",
      detail: hasCookies
        ? "yt-dlp: oturum/çerez reddedildi (401/403). cookies.txt yenileyin."
        : "yt-dlp: giriş gerekli — Ayarlar → Instagram oturumu (cookies.txt).",
    };
  }

  if (
    low.includes("is not currently live") ||
    low.includes("not live") ||
    low.includes("no longer available")
  ) {
    return {
      ok: false,
      kind: "not_found",
      detail: "yt-dlp: kullanıcı şu an canlıda değil.",
    };
  }

  if (
    low.includes("[generic]") ||
    low.includes("unsupported url") ||
    low.includes("unable to extract") ||
    low.includes("no suitable extractor")
  ) {
    return {
      ok: false,
      kind: "error",
      detail:
        "yt-dlp: Instagram Live çıkarıcısı yok (generic IE). Playwright+çerez ile çözülmeye çalışılacak.",
    };
  }

  if (code !== 0) {
    const snip = stderr.replace(/\s+/g, " ").trim().slice(0, 180);
    return {
      ok: false,
      kind: "error",
      detail: snip
        ? `yt-dlp hata: ${snip}`
        : "yt-dlp canlı meta verisi alınamadı.",
    };
  }

  return null;
}

/**
 * Probe whether a live is capturable.
 * 1) yt-dlp -J with cookies (often fails: no IG Live IE / 429)
 * 2) Playwright + spare-account cookies → live info → DASH URL
 */
export async function probePublicLive(
  env: AppEnv,
  watchUrl: string,
): Promise<ProbeResult> {
  const cookiesPath = await resolveCookiesPath(env);
  const hasCookies = Boolean(cookiesPath);
  const auth = await ytDlpAuthArgs(env);
  const bin = await ytDlpBinResolved();

  const r = await runCapture(
    [
      bin,
      "--ignore-config",
      "--no-playlist",
      "--no-warnings",
      "--skip-download",
      ...auth,
      "-J",
      watchUrl,
    ],
    45_000,
  );

  const ytdlp = classifyYtDlpProbeFailure(r.code, r.stdout, r.stderr, hasCookies);
  if (ytdlp?.ok) return ytdlp;

  // Playwright path — required for real IG Live (login-gated even when browser-watchable)
  const pw = await resolveLiveStreamWithPlaywright(env, {
    watchUrl,
    username: usernameFromWatchUrl(watchUrl) ?? undefined,
    broadcastId: extractBroadcastIdFromUrl(watchUrl),
  });

  if (pw.ok) {
    await setIgSessionLastError(env, null);
    return {
      ok: true,
      detail: pw.detail,
      streamUrl: pw.streamUrl,
    };
  }

  if (pw.kind === "blocked") {
    await setIgSessionLastError(env, pw.detail);
    return { ok: false, kind: "blocked", detail: pw.detail };
  }

  // Prefer Playwright's concrete reason; fall back to yt-dlp taxonomy
  if (pw.kind === "rate_limited") {
    return { ok: false, kind: "rate_limited", detail: pw.detail };
  }
  if (pw.kind === "not_found") {
    return { ok: false, kind: "not_found", detail: pw.detail };
  }

  if (ytdlp && !ytdlp.ok) {
    // Surface the more specific of the two
    if (ytdlp.kind === "rate_limited" || ytdlp.kind === "blocked") {
      return ytdlp;
    }
  }

  return {
    ok: false,
    kind: pw.kind,
    detail: pw.detail,
  };
}

export async function createLiveCapture(
  sql: Sql,
  env: AppEnv,
  opts: {
    input: string;
    displayName?: string;
    notes?: string;
    /** Empty/0 = entire live until it ends. */
    maxDurationMinutes?: number | null;
  },
) {
  const parsed = parseLiveSourceInput(opts.input);
  const seller = await upsertSeller(sql, parsed.username);
  if (opts.displayName?.trim()) {
    await sql`
      UPDATE sellers
      SET display_name = ${opts.displayName.trim()}, updated_at = now()
      WHERE id = ${seller.id}
    `;
  }

  let maxDurationMinutes: number | null = null;
  if (
    opts.maxDurationMinutes != null &&
    Number.isFinite(opts.maxDurationMinutes) &&
    opts.maxDurationMinutes > 0
  ) {
    maxDurationMinutes = Math.min(
      Math.floor(opts.maxDurationMinutes),
      24 * 60,
    );
  }

  const id = crypto.randomUUID();
  const filename = `live-${parsed.username}-${id.slice(0, 8)}.mp4`;
  const destAbs = safeJoinStorage(env.storageRoot, "recordings", `${id}.mp4`);
  await mkdir(join(env.storageRoot, "recordings"), { recursive: true });
  const storagePath = toStorageKey(env.storageRoot, destAbs);
  const maxBytes = maxLiveBytes(env);

  await sql`
    INSERT INTO recordings (
      id, seller_id, original_filename, storage_path, recorded_at,
      status, notes, source_type, source_input, source_url,
      capture_status, file_size_bytes
    ) VALUES (
      ${id}, ${seller.id}, ${filename}, ${storagePath}, ${new Date().toISOString()},
      'awaiting_live', ${opts.notes ?? null}, 'live', ${parsed.inputRaw}, ${parsed.watchUrl},
      'bekleniyor', 0
    )
  `;

  await sql`
    INSERT INTO live_captures (
      recording_id, input_raw, source_kind, resolved_username, watch_url,
      status, max_bytes, max_duration_minutes
    ) VALUES (
      ${id}, ${parsed.inputRaw}, ${parsed.kind}, ${parsed.username}, ${parsed.watchUrl},
      'waiting', ${maxBytes}, ${maxDurationMinutes}
    )
  `;

  // Immediate first probe so UI is not stuck on silent "bekleniyor" until tick
  const first = await probePublicLive(env, parsed.watchUrl);
  let captureStatus: string = "bekleniyor";
  let lastError: string | null = first.ok ? null : first.detail;
  if (first.ok) {
    await setIgSessionLastError(env, null);
    await sql`
      UPDATE live_captures
      SET attempt_count = 1, last_probe_at = now(),
          last_probe_detail = ${first.detail}, updated_at = now()
      WHERE recording_id = ${id}
    `;
    // Kick recording ASAP (supervisor will no-op if already active)
    void startRecordingProcess(
      sql,
      env,
      id,
      parsed.watchUrl,
      destAbs,
      maxBytes,
      maxDurationMinutes,
      first.streamUrl,
    );
  } else if (first.kind === "blocked") {
    captureStatus = "engellendi";
    await sql`
      UPDATE live_captures
      SET status = 'blocked', attempt_count = 1, last_probe_at = now(),
          last_probe_detail = ${first.detail}, updated_at = now()
      WHERE recording_id = ${id}
    `;
    await sql`
      UPDATE recordings
      SET capture_status = 'engellendi', capture_error = ${first.detail},
          updated_at = now()
      WHERE id = ${id}
    `;
  } else {
    // not_found / rate_limited / error → keep waiting, but show real reason
    await sql`
      UPDATE live_captures
      SET attempt_count = 1, last_probe_at = now(),
          last_probe_detail = ${first.detail}, updated_at = now()
      WHERE recording_id = ${id}
    `;
    await sql`
      UPDATE recordings
      SET capture_error = ${first.detail}, updated_at = now()
      WHERE id = ${id}
    `;
  }

  return {
    recordingId: id,
    username: parsed.username,
    watchUrl: parsed.watchUrl,
    captureStatus,
    lastError,
    lastProbeDetail: first.detail,
    maxDurationMinutes,
    quality: CAPTURE_QUALITY,
    policy: LIVE_CAPTURE_POLICY,
  };
}

/** After cookies refresh: move blocked session back to waiting. */
export async function resumeBlockedLiveCapture(sql: Sql, recordingId: string) {
  const rows = await sql<{ status: string }[]>`
    SELECT status FROM live_captures WHERE recording_id = ${recordingId}
  `;
  if (!rows[0]) throw new Error("Canlı oturum bulunamadı");
  if (rows[0].status !== "blocked" && rows[0].status !== "not_found") {
    throw new Error(`Oturum durumu yeniden denemeye uygun değil (${rows[0].status})`);
  }
  await sql`
    UPDATE live_captures
    SET status = 'waiting', last_probe_detail = ${"Yeniden deneniyor (çerez/oturum güncellendi)"},
        updated_at = now()
    WHERE recording_id = ${recordingId}
  `;
  await sql`
    UPDATE recordings
    SET status = 'awaiting_live', capture_status = 'bekleniyor',
        capture_error = NULL, error_message = NULL, updated_at = now()
    WHERE id = ${recordingId}
  `;
  return { ok: true, captureStatus: "bekleniyor" as const };
}

export async function cancelLiveCapture(sql: Sql, recordingId: string) {
  const proc = activeProcs.get(recordingId);
  if (proc && !proc.killed) {
    try {
      proc.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }
  activeProcs.delete(recordingId);
  await sql`
    UPDATE live_captures
    SET status = 'cancelled', updated_at = now(), process_pid = NULL
    WHERE recording_id = ${recordingId}
      AND status IN ('pending', 'waiting', 'recording', 'finalizing')
  `;
  await sql`
    UPDATE recordings
    SET status = 'cancelled',
        capture_status = 'iptal',
        capture_ended_at = now(),
        updated_at = now()
    WHERE id = ${recordingId}
      AND status IN ('awaiting_live', 'recording')
  `;
  return { ok: true };
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

/**
 * Resolve live media URL(s). Prefer Playwright DASH (IG Live).
 * yt-dlp -g as secondary (rarely works — no IG Live extractor).
 */
async function resolveStreamInput(
  env: AppEnv,
  watchUrl: string,
  preferredStreamUrl?: string | null,
): Promise<
  | { input: CaptureInput; detail: string }
  | { error: string; kind: "blocked" | "not_found" | "rate_limited" | "error" }
> {
  if (preferredStreamUrl && /^https?:\/\//i.test(preferredStreamUrl)) {
    return {
      input: { kind: "muxed", url: preferredStreamUrl },
      detail: "stream_from_probe",
    };
  }

  const pw = await resolveLiveStreamWithPlaywright(env, {
    watchUrl,
    username: usernameFromWatchUrl(watchUrl) ?? undefined,
    broadcastId: extractBroadcastIdFromUrl(watchUrl),
  });
  if (pw.ok) {
    return {
      input: { kind: "muxed", url: pw.streamUrl },
      detail: pw.detail,
    };
  }

  const bin = await ytDlpBinResolved();
  const auth = await ytDlpAuthArgs(env);
  const r = await runCapture(
    [
      bin,
      "--ignore-config",
      "--no-playlist",
      "--no-warnings",
      ...auth,
      "-f",
      CAPTURE_QUALITY.ytdlpFormat,
      "-g",
      watchUrl,
    ],
    45_000,
  );
  const lines = r.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^https?:\/\//i.test(l));
  if (lines.length >= 2) {
    return {
      input: { kind: "separate", videoUrl: lines[0]!, audioUrl: lines[1]! },
      detail: "ytdlp_dual_url",
    };
  }
  if (lines[0]) {
    return {
      input: { kind: "muxed", url: lines[0]! },
      detail: "ytdlp_single_url",
    };
  }

  return {
    kind: pw.kind,
    error: pw.detail,
  };
}

async function startRecordingProcess(
  sql: Sql,
  env: AppEnv,
  recordingId: string,
  watchUrl: string,
  destAbs: string,
  maxBytes: number,
  maxDurationMinutes: number | null,
  preferredStreamUrl?: string | null,
) {
  const partAbs = `${destAbs}.part.mp4`;
  try {
    await unlink(partAbs);
  } catch {
    /* ok */
  }

  const resolved = await resolveStreamInput(env, watchUrl, preferredStreamUrl);
  if ("error" in resolved) {
    const blocked = resolved.kind === "blocked";
    await sql`
      UPDATE live_captures
      SET status = ${blocked ? "blocked" : "waiting"},
          last_probe_detail = ${resolved.error},
          updated_at = now()
      WHERE recording_id = ${recordingId}
    `;
    await sql`
      UPDATE recordings
      SET status = 'awaiting_live',
          capture_status = ${blocked ? "engellendi" : "bekleniyor"},
          capture_error = ${resolved.error},
          updated_at = now()
      WHERE id = ${recordingId}
    `;
    if (blocked) {
      await setIgSessionLastError(env, resolved.error);
      console.warn(`[live-capture] stream URL blocked ${recordingId}: ${resolved.error}`);
    }
    return;
  }

  const maxDurationSeconds =
    maxDurationMinutes && maxDurationMinutes > 0
      ? maxDurationMinutes * 60
      : null;

  const args = ffmpegCaptureArgs({
    ffmpegPath: env.ffmpegPath,
    input: resolved.input,
    outputPath: partAbs,
    maxDurationSeconds,
  });

  const child = spawn(args[0]!, args.slice(1), {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });
  activeProcs.set(recordingId, child);

  const detail = maxDurationSeconds
    ? `recording_started max=${maxDurationMinutes}dk quality<=${CAPTURE_QUALITY.maxHeight}p`
    : `recording_started full_live quality<=${CAPTURE_QUALITY.maxHeight}p`;

  await sql`
    UPDATE live_captures
    SET status = 'recording', process_pid = ${child.pid ?? null},
        updated_at = now(), last_probe_detail = ${detail}
    WHERE recording_id = ${recordingId}
  `;
  await sql`
    UPDATE recordings
    SET status = 'recording',
        capture_status = 'kaydediliyor',
        capture_started_at = COALESCE(capture_started_at, now()),
        capture_error = NULL,
        updated_at = now()
    WHERE id = ${recordingId}
  `;

  let stderr = "";
  child.stderr.on("data", (d) => {
    stderr += String(d);
    if (stderr.length > 120_000) stderr = stderr.slice(-60_000);
  });

  const startedAt = Date.now();
  const sizeTimer = setInterval(() => {
    void (async () => {
      const bytes = await fileSize(partAbs);
      await sql`
        UPDATE recordings
        SET capture_bytes = ${bytes}, file_size_bytes = ${bytes}, updated_at = now()
        WHERE id = ${recordingId}
      `;
      const overBytes = bytes >= maxBytes;
      const overTime =
        maxDurationSeconds != null &&
        Date.now() - startedAt >= maxDurationSeconds * 1000 + 5000;
      if (overBytes || overTime) {
        try {
          child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
      }
    })();
  }, 5000);

  child.on("close", (code) => {
    clearInterval(sizeTimer);
    activeProcs.delete(recordingId);
    void finalizeRecording(sql, env, recordingId, destAbs, partAbs, code, stderr);
  });
}

async function finalizeRecording(
  sql: Sql,
  env: AppEnv,
  recordingId: string,
  destAbs: string,
  partAbs: string,
  code: number | null,
  stderr: string,
) {
  const rows = await sql<{ status: string }[]>`
    SELECT status FROM live_captures WHERE recording_id = ${recordingId}
  `;
  if (!rows[0] || rows[0].status === "cancelled") return;

  await sql`
    UPDATE live_captures SET status = 'finalizing', updated_at = now(), process_pid = NULL
    WHERE recording_id = ${recordingId}
  `;

  const bytes = await fileSize(partAbs);
  const low = stderr.toLowerCase();
  const blocked =
    low.includes("login required") ||
    low.includes("http error 401") ||
    low.includes("http error 403");

  if (bytes < 64_000) {
    try {
      await unlink(partAbs);
    } catch {
      /* ignore */
    }
    const kind = blocked ? "blocked" : "not_found";
    const captureStatus = blocked ? "engellendi" : "bulunamadi";
    const detail = blocked
      ? "Erişim engellendi — Instagram giriş olmadan akışı vermedi."
      : "Kayıt dosyası oluşmadı veya yayın kapandı (yetersiz veri).";
    await sql`
      UPDATE live_captures
      SET status = ${kind}, last_probe_detail = ${detail}, updated_at = now()
      WHERE recording_id = ${recordingId}
    `;
    // Return to waiting if not clearly blocked forever — keep monitoring
    if (!blocked) {
      await sql`
        UPDATE live_captures SET status = 'waiting', updated_at = now()
        WHERE recording_id = ${recordingId}
      `;
      await sql`
        UPDATE recordings
        SET status = 'awaiting_live',
            capture_status = 'bekleniyor',
            capture_error = ${detail},
            capture_bytes = 0,
            updated_at = now()
        WHERE id = ${recordingId}
      `;
      return;
    }
    await sql`
      UPDATE recordings
      SET status = 'failed',
          capture_status = ${captureStatus},
          capture_error = ${detail},
          capture_ended_at = now(),
          error_message = ${detail},
          updated_at = now()
      WHERE id = ${recordingId}
    `;
    return;
  }

  try {
    await rename(partAbs, destAbs);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await sql`
      UPDATE live_captures SET status = 'failed', last_probe_detail = ${msg}, updated_at = now()
      WHERE recording_id = ${recordingId}
    `;
    await sql`
      UPDATE recordings
      SET status = 'failed', capture_status = 'hata', capture_error = ${msg},
          error_message = ${msg}, capture_ended_at = now(), updated_at = now()
      WHERE id = ${recordingId}
    `;
    return;
  }

  const finalBytes = await fileSize(destAbs);
  let syncDetail = "A/V sync check skipped";
  try {
    const sync = await probeAvSync(env.ffprobePath, destAbs);
    syncDetail = sync.detailTr;
    if (!sync.ok) {
      console.warn(`[live-capture] ${recordingId} ${sync.detailTr}`);
    }
  } catch (err) {
    syncDetail = err instanceof Error ? err.message : String(err);
  }
  await sql`
    UPDATE live_captures
    SET status = 'completed',
        last_probe_detail = ${syncDetail},
        updated_at = now()
    WHERE recording_id = ${recordingId}
  `;
  await sql`
    UPDATE recordings
    SET status = 'uploaded',
        capture_status = 'bitti',
        capture_ended_at = now(),
        capture_bytes = ${finalBytes},
        file_size_bytes = ${finalBytes},
        capture_error = NULL,
        updated_at = now()
    WHERE id = ${recordingId}
  `;
  await enqueueAnalysisPipeline(sql, recordingId);
  console.log(
    `[live-capture] finalized ${recordingId} bytes=${finalBytes} exit=${code}`,
  );
}

async function tickCapture(sql: Sql, env: AppEnv, row: {
  recording_id: string;
  watch_url: string;
  status: string;
  created_at: Date | string;
  max_bytes: number | string;
  max_duration_minutes: number | null;
  attempt_count: number;
}) {
  const recordingId = row.recording_id;
  if (activeProcs.has(recordingId)) return;

  const age = Date.now() - new Date(row.created_at).getTime();
  if (age > maxWaitMs()) {
    await sql`
      UPDATE live_captures
      SET status = 'not_found',
          last_probe_detail = ${"Maksimum bekleme süresi doldu"},
          updated_at = now()
      WHERE recording_id = ${recordingId}
    `;
    await sql`
      UPDATE recordings
      SET status = 'failed',
          capture_status = 'bulunamadi',
          capture_error = ${"Maksimum bekleme süresi doldu — canlı yayın bulunamadı."},
          error_message = ${"Maksimum bekleme süresi doldu"},
          capture_ended_at = now(),
          updated_at = now()
      WHERE id = ${recordingId}
    `;
    return;
  }

  const probe = await probePublicLive(env, row.watch_url);
  if (probe.ok) {
    await setIgSessionLastError(env, null);
  }
  await sql`
    UPDATE live_captures
    SET attempt_count = attempt_count + 1,
        last_probe_at = now(),
        last_probe_detail = ${probe.ok ? probe.detail : probe.detail},
        updated_at = now()
    WHERE recording_id = ${recordingId}
  `;

  if (!probe.ok) {
    const captureStatus = probe.kind === "blocked" ? "engellendi" : "bekleniyor";
    await sql`
      UPDATE recordings
      SET capture_status = ${captureStatus},
          capture_error = ${probe.detail},
          status = 'awaiting_live',
          updated_at = now()
      WHERE id = ${recordingId}
        AND status IN ('awaiting_live', 'recording')
    `;
    if (probe.kind === "blocked") {
      // Stop silent retries — surface engellendi until operator refreshes cookies
      await sql`
        UPDATE live_captures
        SET status = 'blocked',
            last_probe_detail = ${probe.detail},
            updated_at = now()
        WHERE recording_id = ${recordingId}
      `;
      console.warn(`[live-capture] blocked ${recordingId}: ${probe.detail}`);
    }
    return;
  }

  const destAbs = safeJoinStorage(
    env.storageRoot,
    "recordings",
    `${recordingId}.mp4`,
  );
  await startRecordingProcess(
    sql,
    env,
    recordingId,
    row.watch_url,
    destAbs,
    Number(row.max_bytes),
    row.max_duration_minutes != null && Number(row.max_duration_minutes) > 0
      ? Number(row.max_duration_minutes)
      : null,
    probe.streamUrl,
  );
}

let supervisorStartedAt: string | null = null;
let supervisorTickCount = 0;
let supervisorLastTickAt: string | null = null;
let supervisorLastError: string | null = null;

export function getLiveSupervisorHealth() {
  return {
    enabled: process.env.LIVE_CAPTURE_SUPERVISOR !== "0",
    loopStarted,
    startedAt: supervisorStartedAt,
    tickCount: supervisorTickCount,
    lastTickAt: supervisorLastTickAt,
    lastError: supervisorLastError,
    activeRecordings: activeProcs.size,
    probeIntervalMs: probeIntervalMs(),
  };
}

export async function liveCaptureLoop(sql: Sql, env: AppEnv) {
  if (loopStarted) return;
  loopStarted = true;
  supervisorStartedAt = new Date().toISOString();
  console.log("[live-capture] supervisor started");

  // Resume waiting sessions after restart
  await sql`
    UPDATE live_captures
    SET status = 'waiting', process_pid = NULL, updated_at = now()
    WHERE status IN ('recording', 'finalizing', 'pending')
  `;
  await sql`
    UPDATE recordings
    SET status = 'awaiting_live', capture_status = 'bekleniyor', updated_at = now()
    WHERE status = 'recording' AND source_type = 'live'
  `;

  for (;;) {
    try {
      supervisorTickCount += 1;
      supervisorLastTickAt = new Date().toISOString();
      supervisorLastError = null;
      const rows = await sql<{
        recording_id: string;
        watch_url: string;
        status: string;
        created_at: Date;
        max_bytes: number;
        max_duration_minutes: number | null;
        attempt_count: number;
      }[]>`
        SELECT recording_id, watch_url, status, created_at, max_bytes,
               max_duration_minutes, attempt_count
        FROM live_captures
        WHERE status IN ('pending', 'waiting')
        ORDER BY created_at ASC
        LIMIT 10
      `;
      for (const row of rows) {
        await tickCapture(sql, env, row);
      }
    } catch (err) {
      supervisorLastError = err instanceof Error ? err.message : String(err);
      console.error("[live-capture] tick error", err);
    }
    await Bun.sleep(probeIntervalMs());
  }
}
