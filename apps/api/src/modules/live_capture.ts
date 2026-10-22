/**
 * Module H — Live capture via yt-dlp/ffmpeg.
 *
 * Operator may supply their own backup Instagram session under
 * Ayarlar → Instagram oturumu (cookies preferred). No private API,
 * no anti-bot kits — only the session the operator provides.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
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
  ffmpegFinalizeRemuxArgs,
  type CaptureInput,
} from "./capture_quality.ts";
import { probeAvSync } from "../lib/ffmpeg.ts";
import {
  extractBroadcastIdFromUrl,
  ensureLiveViewerPresence,
  getLiveViewerPresenceHealth,
  getLiveViewerSession,
  resolveLiveStreamWithPlaywright,
  startLiveViewerPresence,
  stopLiveViewerPresence,
  usernameFromWatchUrl,
  type LiveCommentHit,
} from "./ig_live_playwright.ts";
import {
  appendCommentAssCue,
  burnCommentsIntoMaster,
  commentsAssPath,
  COMMENT_DROUGHT_MINUTES,
} from "./comment_burnin.ts";
import {
  COMMENT_FREEZE_MINUTES,
  commentFingerprint,
} from "./live_comment_capture.ts";
import { access } from "node:fs/promises";
import { resolve } from "node:path";

function attachViewerPresence(
  sql: Sql,
  env: AppEnv,
  opts: {
    recordingId: string;
    watchUrl: string;
    username?: string;
    broadcastId?: string | null;
    /** First start may force fresh; watchdog uses ensure. */
    mode: "start" | "ensure";
  },
) {
  const onComments = (hits: LiveCommentHit[]) =>
    persistLiveComments(sql, env, opts.recordingId, hits);
  const run =
    opts.mode === "ensure"
      ? ensureLiveViewerPresence(env, {
          recordingId: opts.recordingId,
          watchUrl: opts.watchUrl,
          username: opts.username,
          broadcastId: opts.broadcastId,
          onComments,
        })
      : startLiveViewerPresence(env, {
          recordingId: opts.recordingId,
          watchUrl: opts.watchUrl,
          username: opts.username,
          broadcastId: opts.broadcastId,
          onComments,
        }).then((r) =>
          r.ok
            ? { ok: true as const, presence: r.presence, reused: false }
            : r,
        );
  void run
    .then((r) => {
      if (!r.ok) {
        console.error(
          `[live-viewer] ${opts.recordingId} FAILED: ${r.detail}`,
        );
        return;
      }
      if (r.reused) return;
      console.log(
        `[live-viewer] ${opts.recordingId} presence ready (comments=on)`,
      );
    })
    .catch((err) => {
      console.error(
        `[live-viewer] ${opts.recordingId} unhandled:`,
        err instanceof Error ? err.message : err,
      );
    });
}

/** Persist live comments from API and/or DOM (DASH has no comment overlay). */
export async function persistLiveComments(
  sql: Sql,
  env: AppEnv,
  recordingId: string,
  hits: LiveCommentHit[],
): Promise<number> {
  const now = Date.now();
  const [rec] = await sql<{ capture_started_at: Date | string | null }[]>`
    SELECT capture_started_at FROM recordings WHERE id = ${recordingId}
  `;
  const startMs = rec?.capture_started_at
    ? new Date(rec.capture_started_at).getTime()
    : null;
  const assPath = commentsAssPath(
    safeJoinStorage(env.storageRoot, "recordings", `${recordingId}.mp4`),
  );
  let inserted = 0;
  for (const h of hits) {
    const body = h.text.trim();
    if (body.length < 1) continue;
    const author =
      h.username && /^[a-z0-9._]{1,30}$/i.test(h.username)
        ? h.username.toLowerCase()
        : null;
    let offsetMs: number | null = null;
    if (h.createdAtMs != null && startMs != null) {
      offsetMs = Math.max(0, h.createdAtMs - startMs);
    } else if (startMs != null) {
      offsetMs = Math.max(0, now - startMs);
    }
    const observedAt =
      h.createdAtMs != null ? new Date(h.createdAtMs) : new Date(now);
    const source = h.channel === "live_dom" ? "live_dom" : "live_api";
    const fp = commentFingerprint({
      username: author,
      text: body,
      createdAtMs: h.createdAtMs ?? now,
    });
    // Dedupe by IG pk (any live_* source) OR fingerprint (user+text+~5s bucket)
    if (h.pk) {
      const [dup] = await sql<{ id: string }[]>`
        SELECT id FROM observed_comments
        WHERE recording_id = ${recordingId}
          AND source IN ('live_api', 'live_dom')
          AND raw_json->>'pk' = ${h.pk}
        LIMIT 1
      `;
      if (dup) continue;
    } else {
      const [dup] = await sql<{ id: string }[]>`
        SELECT id FROM observed_comments
        WHERE recording_id = ${recordingId}
          AND source IN ('live_api', 'live_dom')
          AND (
            raw_json->>'fp' = ${fp}
            OR (
              lower(coalesce(author_username, '')) = ${author ?? ""}
              AND lower(body) = ${body.toLowerCase()}
              AND offset_ms IS NOT NULL
              AND ${offsetMs} IS NOT NULL
              AND abs(offset_ms - ${offsetMs}) < 8000
            )
          )
        LIMIT 1
      `;
      if (dup) continue;
    }
    await sql`
      INSERT INTO observed_comments
        (recording_id, body, author_username, source, offset_ms, observed_at, raw_json)
      VALUES (
        ${recordingId},
        ${body},
        ${author},
        ${source},
        ${offsetMs},
        ${observedAt},
        ${sql.json({
          pk: h.pk,
          fp,
          channel: source,
          createdAtMs: h.createdAtMs,
          username: h.username,
        })}
      )
    `;
    inserted += 1;
    // Sidecar ASS for finalize burn-in (human QC in Video player)
    try {
      await appendCommentAssCue(assPath, {
        offsetMs: offsetMs ?? 0,
        username: author,
        text: body,
      });
    } catch (err) {
      console.warn(
        `[live-comments] ${recordingId} ASS append:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  if (inserted) {
    // Clear drought / freeze warning once comments flow
    try {
      await sql`
        UPDATE live_captures
        SET comments_warning = NULL, updated_at = now()
        WHERE recording_id = ${recordingId}
          AND comments_warning IS NOT NULL
      `;
    } catch {
      /* column may not exist until migrate */
    }
    console.log(
      `[live-comments] ${recordingId} +${inserted}/${hits.length} (authors=${hits.filter((x) => x.username).length})`,
    );
  }
  return inserted;
}

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
/** Single-flight finalize per recording — close-handler + stall watchdog must not remux the same .part concurrently (glam part2 lost ~877MB). */
const finalizeInFlight = new Map<string, Promise<void>>();

/**
 * ffmpeg uses -reconnect on the DASH URL. When IG live ends, CDN often keeps
 * serving a static leftover MPD — ffmpeg spins forever and the .part stops growing.
 * Finalize after this much no-growth (wall clock).
 */
const CAPTURE_STALE_BYTES_MS = Number(
  process.env.LIVE_CAPTURE_STALE_BYTES_MS ?? String(3 * 60_000),
);
/** If finalize stays in `finalizing` this long, force-complete (burn hang). */
const FINALIZE_STUCK_MS = Number(
  process.env.LIVE_FINALIZE_STUCK_MS ?? String(5 * 60_000),
);
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
  | { ok: true; detail: string; streamUrl?: string; broadcastId?: string }
  | {
      ok: false;
      kind: "blocked" | "not_found" | "rate_limited" | "error";
      detail: string;
    };

/** Ensure watch URL carries broadcast_id so comment polling can resume after restart. */
export function watchUrlWithBroadcastId(
  watchUrl: string,
  broadcastId: string | null | undefined,
): string {
  if (!broadcastId || !/^\d{5,}$/.test(broadcastId)) return watchUrl;
  try {
    const u = new URL(watchUrl);
    if (u.searchParams.get("broadcast_id") === broadcastId) return watchUrl;
    u.searchParams.set("broadcast_id", broadcastId);
    return u.toString();
  } catch {
    return watchUrl;
  }
}

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
      broadcastId: pw.broadcastId,
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

  // Hard dedupe: never start a second capture for the same seller or broadcast
  // (manual double-click / auto-follow race). Return the healthy in-flight one.
  const wantBid = extractBroadcastIdFromUrl(parsed.watchUrl);
  const activeDup = await sql<{
    recording_id: string;
    username: string;
    watch_url: string | null;
    source_url: string | null;
    capture_status: string | null;
    max_duration_minutes: number | null;
    last_probe_detail: string | null;
    capture_error: string | null;
  }[]>`
    SELECT lc.recording_id, s.instagram_username AS username,
           lc.watch_url, r.source_url, r.capture_status,
           lc.max_duration_minutes, lc.last_probe_detail, r.capture_error
    FROM live_captures lc
    JOIN recordings r ON r.id = lc.recording_id
    JOIN sellers s ON s.id = r.seller_id
    WHERE lc.status IN ('pending', 'waiting', 'recording', 'finalizing')
       OR r.capture_status IN ('bekleniyor', 'kaydediliyor')
       OR r.status IN ('awaiting_live', 'recording')
  `;
  const usernameLc = parsed.username.toLowerCase();
  const hit = activeDup.find((row) => {
    const u = String(row.username || "").toLowerCase();
    if (u === usernameLc) return true;
    if (!wantBid) return false;
    const bid =
      extractBroadcastIdFromUrl(row.watch_url || "") ||
      extractBroadcastIdFromUrl(row.source_url || "");
    return bid != null && bid === wantBid;
  });
  if (hit) {
    console.warn(
      `[live-capture] dedupe reuse ${hit.recording_id} for @${parsed.username}` +
        (wantBid ? ` bid=${wantBid}` : ""),
    );
    return {
      recordingId: hit.recording_id,
      username: String(hit.username || parsed.username),
      watchUrl: hit.watch_url || parsed.watchUrl,
      captureStatus: hit.capture_status || "kaydediliyor",
      lastError: hit.capture_error,
      lastProbeDetail:
        hit.last_probe_detail ||
        "Aynı kullanıcı/broadcast zaten kaydediliyor — yeni kayıt açılmadı.",
      maxDurationMinutes: hit.max_duration_minutes,
      quality: CAPTURE_QUALITY,
      policy: LIVE_CAPTURE_POLICY,
      deduped: true as const,
    };
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

  // Immediate first probe — hard timeout so POST never hangs (supervisor continues).
  const FIRST_PROBE_MS = 55_000;
  let first: ProbeResult;
  try {
    first = await Promise.race([
      probePublicLive(env, parsed.watchUrl),
      new Promise<ProbeResult>((resolve) => {
        setTimeout(
          () =>
            resolve({
              ok: false,
              kind: "error",
              detail:
                "İlk probe zaman aşımı — supervisor yeniden deneyecek (bekleniyor).",
            }),
          FIRST_PROBE_MS,
        );
      }),
    ]);
  } catch (err) {
    first = {
      ok: false,
      kind: "error",
      detail:
        err instanceof Error
          ? err.message.slice(0, 200)
          : "İlk probe hatası — supervisor yeniden deneyecek.",
    };
  }
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
  await stopLiveViewerPresence(recordingId);
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

/**
 * True only for a running process. Zombies (stat Z) count as dead — kill(0)
 * still succeeds on them, which previously left kaydediliyor forever (glam).
 */
export function pidAlive(pid: number | null | undefined): boolean {
  if (pid == null || !Number.isFinite(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = raw.lastIndexOf(")");
    const state = close >= 0 ? raw.slice(close + 1).trim().split(/\s+/)[0] : "";
    if (state === "Z") return false;
  } catch {
    /* non-linux / race — treat kill(0) success as alive */
  }
  return true;
}

function dropDeadActiveProc(recordingId: string) {
  const child = activeProcs.get(recordingId);
  if (!child) return;
  const childPid = typeof child.pid === "number" ? child.pid : null;
  if (!pidAlive(childPid)) {
    activeProcs.delete(recordingId);
  }
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
  // Guard: createLiveCapture first-probe + supervisor tick can race
  if (activeProcs.has(recordingId)) {
    console.warn(`[live-capture] skip duplicate start ${recordingId}`);
    return;
  }
  const existingPid = await sql<{ process_pid: number | null; status: string }[]>`
    SELECT process_pid, status FROM live_captures WHERE recording_id = ${recordingId}
  `;
  if (
    existingPid[0]?.status === "recording" &&
    pidAlive(existingPid[0].process_pid != null ? Number(existingPid[0].process_pid) : null)
  ) {
    console.warn(`[live-capture] skip duplicate start (pid alive) ${recordingId}`);
    return;
  }

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

  // Detached so an API restart does not kill a healthy ffmpeg mid-live.
  // Supervisor reattaches via process_pid + part file growth.
  const child = spawn(args[0]!, args.slice(1), {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
    detached: true,
  });
  try {
    child.unref();
  } catch {
    /* ignore */
  }
  activeProcs.set(recordingId, child);

  const detail = maxDurationSeconds
    ? `recording_started max=${maxDurationMinutes}dk quality<=${CAPTURE_QUALITY.maxHeight}p`
    : `recording_started full_live quality<=${CAPTURE_QUALITY.maxHeight}p`;

  // Prefer broadcast_id from resolve so comment poll works even if input was @username only
  const bidFromUrl = extractBroadcastIdFromUrl(watchUrl);
  const bidFromDetail = (() => {
    const m = resolved.detail.match(/bid=(\d{5,})/);
    return m?.[1] ?? null;
  })();
  const broadcastId = bidFromUrl || bidFromDetail;
  const watchUrlPinned = watchUrlWithBroadcastId(watchUrl, broadcastId);

  await sql`
    UPDATE live_captures
    SET status = 'recording', process_pid = ${child.pid ?? null},
        watch_url = ${watchUrlPinned},
        updated_at = now(), last_probe_detail = ${detail}
    WHERE recording_id = ${recordingId}
  `;
  await sql`
    UPDATE recordings
    SET status = 'recording',
        capture_status = 'kaydediliyor',
        capture_started_at = COALESCE(capture_started_at, now()),
        capture_error = NULL,
        source_url = ${watchUrlPinned},
        updated_at = now()
    WHERE id = ${recordingId}
  `;

  // Keep spare-account browser session "watching" so IG can list them as a viewer.
  // Also polls get_comment → observed_comments + ASS sidecar (DASH has no comment UI).
  attachViewerPresence(sql, env, {
    recordingId,
    watchUrl: watchUrlPinned,
    username: usernameFromWatchUrl(watchUrlPinned) ?? undefined,
    broadcastId,
    mode: "start",
  });

  let stderr = "";
  child.stderr.on("data", (d) => {
    stderr += String(d);
    if (stderr.length > 120_000) stderr = stderr.slice(-60_000);
  });

  const startedAt = Date.now();
  let lastBytes = 0;
  let lastGrowthAt = Date.now();
  const sizeTimer = setInterval(() => {
    void (async () => {
      // Prefer part while recording; never overwrite DB with 0 after rename/finalize
      const partBytes = await fileSize(partAbs);
      const destBytes = await fileSize(destAbs);
      const bytes = partBytes > 0 ? partBytes : destBytes;
      if (bytes > lastBytes) {
        lastBytes = bytes;
        lastGrowthAt = Date.now();
      }
      if (bytes > 0) {
        await sql`
          UPDATE recordings
          SET capture_bytes = ${bytes}, file_size_bytes = ${bytes}, updated_at = now()
          WHERE id = ${recordingId}
            AND status IN ('recording', 'awaiting_live')
        `;
      }
      const overBytes = bytes >= maxBytes;
      const overTime =
        maxDurationSeconds != null &&
        Date.now() - startedAt >= maxDurationSeconds * 1000 + 5000;
      const viewer = getLiveViewerSession(recordingId)?.getHealth();
      const broadcastEnded = Boolean(viewer?.broadcastEnded);
      const staleBytes =
        bytes >= 64_000 &&
        Date.now() - lastGrowthAt >= CAPTURE_STALE_BYTES_MS &&
        Date.now() - startedAt >= CAPTURE_STALE_BYTES_MS;
      if (overBytes || overTime || broadcastEnded || staleBytes) {
        if (broadcastEnded || staleBytes) {
          console.warn(
            `[live-capture] ${recordingId} stop: ended=${broadcastEnded} stale=${staleBytes} bytes=${bytes} hb=${viewer?.lastHeartbeatDetail ?? "-"}`,
          );
        }
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
    void stopLiveViewerPresence(recordingId);
    void finalizeRecording(sql, env, recordingId, destAbs, partAbs, code, stderr);
  });
}

async function killCapturePid(pid: number | null | undefined) {
  if (!pidAlive(pid)) return;
  const p = Number(pid);
  try {
    process.kill(p, "SIGTERM");
  } catch {
    /* ignore */
  }
  await Bun.sleep(1500);
  if (pidAlive(p)) {
    try {
      process.kill(p, "SIGKILL");
    } catch {
      /* ignore */
    }
  }
}

/**
 * Enforce max duration / dead-ffmpeg reclaim for a recording row.
 * Critical after API restart: orphaned ffmpeg may exit (e.g. -t) without our
 * close handler — without this, UI stays kaydediliyor forever.
 */
async function forceCompleteStuckFinalize(
  sql: Sql,
  env: AppEnv,
  recordingId: string,
  destAbs: string,
  why: string,
): Promise<void> {
  const finalBytes = await fileSize(destAbs);
  if (finalBytes < 64_000) return;
  let syncDetail = "A/V sync check skipped";
  try {
    const sync = await probeAvSync(env.ffprobePath, destAbs);
    syncDetail = sync.detailTr;
  } catch (err) {
    syncDetail = err instanceof Error ? err.message : String(err);
  }
  const [cCount] = await sql<{ n: string }[]>`
    SELECT COUNT(*)::text AS n FROM observed_comments
    WHERE recording_id = ${recordingId}
      AND source IN ('live_api', 'live_dom')
  `;
  const liveApiN = Number(cCount?.n ?? 0);
  const probeDetail = `${syncDetail} · comments=${liveApiN} · ${why}`;
  await sql`
    UPDATE live_captures
    SET status = 'completed',
        last_probe_detail = ${probeDetail},
        process_pid = NULL,
        updated_at = now()
    WHERE recording_id = ${recordingId}
      AND status IN ('finalizing', 'recording')
  `;
  await sql`
    UPDATE recordings
    SET status = 'uploaded',
        capture_status = 'bitti',
        capture_ended_at = COALESCE(capture_ended_at, now()),
        capture_bytes = ${finalBytes},
        file_size_bytes = ${finalBytes},
        capture_error = NULL,
        notes = COALESCE(notes || E'\n', '') || ${why},
        updated_at = now()
    WHERE id = ${recordingId}
  `;
  await enqueueAnalysisPipeline(sql, recordingId);
  console.warn(
    `[live-capture] force-completed stuck finalize ${recordingId} bytes=${finalBytes}`,
  );
}

async function maybeStartPart2AfterStall(
  sql: Sql,
  env: AppEnv,
  row: { recording_id: string; watch_url: string | null },
  allowPart2: boolean,
): Promise<string | null> {
  if (!allowPart2) {
    console.warn(
      `[live-capture] stall part2 deferred (out-of-process tick) after ${row.recording_id} — API supervisor will rotate`,
    );
    return null;
  }
  const watchUrl = row.watch_url?.trim();
  if (!watchUrl) return null;
  // Confirm live still on before opening segment B
  const probe = await probePublicLive(env, watchUrl);
  if (!probe.ok) {
    console.warn(
      `[live-capture] stall part2 skip ${row.recording_id}: live not active (${probe.detail})`,
    );
    return null;
  }
  console.warn(
    `[live-capture] stall → part2 after ${row.recording_id} (${probe.detail})`,
  );
  try {
    const result = await createLiveCapture(sql, env, {
      input: watchUrl,
      notes: `Part 2 / segment B — continuation after stall of ${row.recording_id}; same broadcast; comments continue on new recording`,
    });
    const part2Id = result.recordingId;
    const note = `Part 2 recording_id=${part2Id} (stall rotate)`;
    await sql`
      UPDATE recordings
      SET notes = COALESCE(notes || E'\n', '') || ${note},
          updated_at = now()
      WHERE id = ${row.recording_id}
    `;
    await sql`
      UPDATE live_captures
      SET last_probe_detail = COALESCE(last_probe_detail || ' · ', '') || ${note},
          updated_at = now()
      WHERE recording_id = ${row.recording_id}
    `;
    return part2Id;
  } catch (err) {
    console.error(
      `[live-capture] part2 start failed after ${row.recording_id}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

async function enforceRecordingWatchdog(
  sql: Sql,
  env: AppEnv,
  row: {
    recording_id: string;
    watch_url?: string | null;
    process_pid: number | null;
    max_duration_minutes: number | null;
    capture_started_at: Date | string | null;
    max_bytes: number | string | null;
    capture_bytes?: number | string | null;
    updated_at?: Date | string | null;
    lc_status?: string | null;
    lc_updated_at?: Date | string | null;
  },
  opts?: { allowPart2?: boolean },
): Promise<"ok" | "finalized" | "killed_waiting_finalize" | "part2"> {
  const allowPart2 = opts?.allowPart2 !== false;
  const recordingId = row.recording_id;
  dropDeadActiveProc(recordingId);

  const destAbs = safeJoinStorage(
    env.storageRoot,
    "recordings",
    `${recordingId}.mp4`,
  );
  const partAbs = `${destAbs}.part.mp4`;
  const partBytes = await fileSize(partAbs);
  const finalBytes = await fileSize(destAbs);
  const pid = row.process_pid != null ? Number(row.process_pid) : null;
  const alive = pidAlive(pid) || activeProcs.has(recordingId);

  // Hung finalize (burn / remux) must not leave Funnel on kaydediliyor forever.
  const lcStatus = row.lc_status;
  const lcUpdatedMs = row.lc_updated_at
    ? new Date(row.lc_updated_at).getTime()
    : NaN;
  if (
    lcStatus === "finalizing" &&
    Number.isFinite(lcUpdatedMs) &&
    Date.now() - lcUpdatedMs >= FINALIZE_STUCK_MS &&
    Math.max(partBytes, finalBytes) >= 64_000
  ) {
    dropDeadActiveProc(recordingId);
    await stopLiveViewerPresence(recordingId);
    if (partBytes >= 64_000) {
      await finalizeRecording(
        sql,
        env,
        recordingId,
        destAbs,
        partAbs,
        0,
        `finalize stuck >${Math.round(FINALIZE_STUCK_MS / 60_000)}dk — reclaim`,
      );
    } else {
      await forceCompleteStuckFinalize(
        sql,
        env,
        recordingId,
        destAbs,
        `finalize stuck >${Math.round(FINALIZE_STUCK_MS / 60_000)}dk — force bitti (burn skipped)`,
      );
    }
    return "finalized";
  }
  if (lcStatus === "finalizing") {
    // In-flight finalize — do not re-attach viewer / start part2 yet.
    return "ok";
  }

  const startedAt = row.capture_started_at
    ? new Date(row.capture_started_at).getTime()
    : NaN;
  const maxMin =
    row.max_duration_minutes != null && Number(row.max_duration_minutes) > 0
      ? Number(row.max_duration_minutes)
      : null;
  const pastMax =
    maxMin != null &&
    Number.isFinite(startedAt) &&
    Date.now() - startedAt >= maxMin * 60_000 + 5_000;

  const maxBytes = Number(row.max_bytes ?? 0);
  const overBytes =
    maxBytes > 0 && Math.max(partBytes, finalBytes) >= maxBytes;

  const viewerHealth = getLiveViewerSession(recordingId)?.getHealth();
  const broadcastEnded = Boolean(viewerHealth?.broadcastEnded);

  // Part mtime / size vs last observed growth — covers orphan ffmpeg after API
  // restart (sizeTimer gone) and reconnect-zombie after live ends.
  let stalePart = false;
  if (Math.max(partBytes, finalBytes) >= 64_000) {
    try {
      const st = await stat(partBytes >= 64_000 ? partAbs : destAbs);
      const mtimeMs = st.mtimeMs;
      const ageMs = Date.now() - mtimeMs;
      stalePart =
        ageMs >= CAPTURE_STALE_BYTES_MS &&
        Number.isFinite(startedAt) &&
        Date.now() - startedAt >= CAPTURE_STALE_BYTES_MS;
    } catch {
      stalePart = false;
    }
  }

  if (pastMax || overBytes || broadcastEnded || stalePart) {
    const why = pastMax
      ? `max_duration ${maxMin}dk aşıldı — zorla durduruluyor`
      : overBytes
        ? `max_bytes aşıldı — zorla durduruluyor`
        : broadcastEnded
          ? `IG canlı bitti (heartbeat status=${viewerHealth?.broadcastStatus ?? "?"}) — finalize`
          : `kayıt dosyası ${Math.round(CAPTURE_STALE_BYTES_MS / 60_000)}dk büyümüyor (ffmpeg zombie/CDN static) — finalize`;
    console.warn(`[live-capture] watchdog ${recordingId}: ${why}`);
    const proc = activeProcs.get(recordingId);
    if (proc && !proc.killed) {
      try {
        proc.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }
    await killCapturePid(pid);
    dropDeadActiveProc(recordingId);
    await stopLiveViewerPresence(recordingId);
    // Prefer close-handler finalize (single-flight). Wait briefly for it before reclaiming.
    if (activeProcs.has(recordingId) || finalizeInFlight.has(recordingId)) {
      await Bun.sleep(2500);
      dropDeadActiveProc(recordingId);
      const inflight = finalizeInFlight.get(recordingId);
      if (inflight) {
        await inflight;
        if (stalePart && !broadcastEnded && !pastMax && !overBytes) {
          const part2 = await maybeStartPart2AfterStall(
            sql,
            env,
            {
              recording_id: recordingId,
              watch_url: row.watch_url ?? null,
            },
            allowPart2,
          );
          if (part2) return "part2";
        }
        return "finalized";
      }
    }
    if (partBytes >= 64_000 || finalBytes >= 64_000) {
      await finalizeRecording(
        sql,
        env,
        recordingId,
        destAbs,
        partAbs,
        pastMax || broadcastEnded || stalePart ? 0 : null,
        why,
      );
      // Bytes stalled but IG still on → open part 2 (same user/broadcast).
      if (stalePart && !broadcastEnded && !pastMax && !overBytes) {
        const part2 = await maybeStartPart2AfterStall(
          sql,
          env,
          {
            recording_id: recordingId,
            watch_url: row.watch_url ?? null,
          },
          allowPart2,
        );
        if (part2) return "part2";
      }
      return "finalized";
    }
  }

  // ffmpeg exited but we lost the close handler (API restart / orphan)
  if (!alive && (partBytes >= 64_000 || finalBytes >= 64_000)) {
    console.warn(
      `[live-capture] reclaim orphan ${recordingId} partBytes=${partBytes} finalBytes=${finalBytes}`,
    );
    await stopLiveViewerPresence(recordingId);
    await finalizeRecording(
      sql,
      env,
      recordingId,
      destAbs,
      partAbs,
      0,
      "orphan_ffmpeg_reclaim",
    );
    return "finalized";
  }

  if (!alive && partBytes < 64_000 && finalBytes < 64_000) {
    // Dead with nothing useful — return to waiting only if still early
    return "ok";
  }

  return "ok";
}

/**
 * Copy-remux fragmented/in-progress MP4 → progressive master with moov atom.
 * Returns ok=false if ffmpeg fails (caller may rename as last resort).
 */
async function remuxOnce(
  env: AppEnv,
  partAbs: string,
  tmpAbs: string,
  movflags: string | null,
): Promise<{ ok: boolean; error?: string }> {
  const args = ffmpegFinalizeRemuxArgs({
    ffmpegPath: env.ffmpegPath,
    inputPath: partAbs,
    outputPath: tmpAbs,
    movflags,
  });
  try {
    const proc = Bun.spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });
    const [stderrText, exitCode] = await Promise.all([
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) {
      try {
        await unlink(tmpAbs);
      } catch {
        /* ignore */
      }
      return {
        ok: false,
        error: `remux exit ${exitCode}: ${stderrText.slice(0, 240)}`,
      };
    }
    if ((await fileSize(tmpAbs)) < 64_000) {
      try {
        await unlink(tmpAbs);
      } catch {
        /* ignore */
      }
      return { ok: false, error: "remux produced tiny file" };
    }
    // +faststart on long fragmented captures can rewrite a corrupt mvhd
    // (nb_streams=0). Never promote until video stream is readable.
    try {
      const sync = await probeAvSync(env.ffprobePath, tmpAbs);
      if (!sync.hasVideo) {
        try {
          await unlink(tmpAbs);
        } catch {
          /* ignore */
        }
        return {
          ok: false,
          error: `remux unreadable (no video stream): ${sync.detailTr}`,
        };
      }
    } catch (err) {
      try {
        await unlink(tmpAbs);
      } catch {
        /* ignore */
      }
      return {
        ok: false,
        error: `remux probe failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
    return { ok: true };
  } catch (err) {
    try {
      await unlink(tmpAbs);
    } catch {
      /* ignore */
    }
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function remuxCaptureToMaster(
  env: AppEnv,
  partAbs: string,
  destAbs: string,
): Promise<{ ok: boolean; error?: string }> {
  // Unique tmp per attempt — concurrent finalize must never clobber the same path.
  const tmpAbs = `${destAbs}.remux.${process.pid}.${Date.now()}.tmp.mp4`;
  // Prefer +faststart; if probe fails, retry without movflags (still progressive
  // enough for players; avoids afra/69765459-class corrupt mvhd).
  let result = await remuxOnce(env, partAbs, tmpAbs, CAPTURE_QUALITY.finalizeMovflags);
  if (!result.ok) {
    console.warn(
      `[live-capture] remux+faststart failed (${result.error}); retry without movflags`,
    );
    result = await remuxOnce(env, partAbs, tmpAbs, null);
  }
  if (!result.ok) return result;
  const tmpBytes = await fileSize(tmpAbs);
  if (tmpBytes < 64_000) {
    try {
      await unlink(tmpAbs);
    } catch {
      /* ignore */
    }
    return { ok: false, error: "remux tmp missing/empty after reported success" };
  }
  // Atomic replace on same filesystem. Do NOT unlink(dest) first — that window
  // + a failed rename deleted glam part2's only copy after a concurrent remux.
  try {
    await rename(tmpAbs, destAbs);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[live-capture] remux rename failed (tmp kept): ${tmpAbs} → ${destAbs}: ${msg}`,
    );
    return {
      ok: false,
      error: `remux rename failed: ${msg} (tmp kept at ${tmpAbs})`,
    };
  }
  if ((await fileSize(destAbs)) < 64_000) {
    return { ok: false, error: "remux dest empty after rename" };
  }
  return { ok: true };
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
  const existing = finalizeInFlight.get(recordingId);
  if (existing) {
    await existing;
    return;
  }
  const run = finalizeRecordingUnlocked(
    sql,
    env,
    recordingId,
    destAbs,
    partAbs,
    code,
    stderr,
  ).finally(() => {
    if (finalizeInFlight.get(recordingId) === run) {
      finalizeInFlight.delete(recordingId);
    }
  });
  finalizeInFlight.set(recordingId, run);
  await run;
}

async function finalizeRecordingUnlocked(
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
  if (rows[0].status === "completed") return;
  // Single-flight map already serializes callers. `finalizing` is allowed so the
  // stuck-finalize watchdog can reclaim after FINALIZE_STUCK_MS (prior crash).

  await sql`
    UPDATE live_captures SET status = 'finalizing', updated_at = now(), process_pid = NULL
    WHERE recording_id = ${recordingId}
      AND status NOT IN ('completed', 'cancelled', 'failed', 'not_found', 'blocked')
  `;
  const claimed = await sql<{ status: string }[]>`
    SELECT status FROM live_captures WHERE recording_id = ${recordingId}
  `;
  if (!claimed[0] || claimed[0].status !== "finalizing") return;

  // Prefer part; if already renamed, treat dest as done
  let bytes = await fileSize(partAbs);
  if (bytes < 64_000) {
    const existing = await fileSize(destAbs);
    if (existing >= 64_000) {
      bytes = existing;
    }
  }
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

  const hadBytes = bytes;
  const partExists = (await fileSize(partAbs)) > 0;
  if (partExists) {
    // Fragmented capture (empty_moov) → progressive +faststart so players seek
    // and max-duration kills never leave an unreadable MP4 (yagmur_xeme class).
    let remuxed: { ok: boolean; error?: string };
    try {
      remuxed = await remuxCaptureToMaster(env, partAbs, destAbs);
    } catch (err) {
      remuxed = {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
      console.error(
        `[live-capture] remux threw ${recordingId}: ${remuxed.error}`,
      );
    }
    if (!remuxed.ok) {
      try {
        await rename(partAbs, destAbs);
      } catch (err) {
        if ((await fileSize(destAbs)) < 64_000) {
          const msg =
            remuxed.error ||
            (err instanceof Error ? err.message : String(err));
          // Keep .part on disk if rename failed — never delete the only copy.
          await sql`
            UPDATE live_captures SET status = 'failed', last_probe_detail = ${msg}, updated_at = now()
            WHERE recording_id = ${recordingId}
          `;
          await sql`
            UPDATE recordings
            SET status = 'failed', capture_status = 'hata', capture_error = ${msg},
                error_message = ${msg}, capture_ended_at = now(),
                capture_bytes = ${hadBytes},
                file_size_bytes = ${hadBytes},
                updated_at = now()
            WHERE id = ${recordingId}
          `;
          return;
        }
      }
    } else {
      // Only drop .part after dest is verified non-empty.
      if ((await fileSize(destAbs)) >= 64_000) {
        try {
          await unlink(partAbs);
        } catch {
          /* part may already be gone */
        }
      } else {
        console.error(
          `[live-capture] remux ok but dest empty — keeping part ${partAbs}`,
        );
      }
    }
  } else if ((await fileSize(destAbs)) < 64_000) {
    const msg = "Finalize: ne part ne final dosya yok";
    await sql`
      UPDATE live_captures SET status = 'failed',
        last_probe_detail = ${msg}, updated_at = now()
      WHERE recording_id = ${recordingId}
    `;
    await sql`
      UPDATE recordings
      SET status = 'failed', capture_status = 'hata',
          capture_error = ${"Kayıt dosyası bulunamadı"},
          capture_ended_at = now(),
          capture_bytes = ${hadBytes},
          file_size_bytes = ${hadBytes},
          updated_at = now()
      WHERE id = ${recordingId}
    `;
    return;
  }

  // Burn polled comments into the master (HUD) — best-effort, never blocks A/V finalize
  let burnDetail = "burn_skipped";
  if ((await fileSize(destAbs)) >= 64_000) {
    try {
      const burned = await burnCommentsIntoMaster({
        ffmpegPath: env.ffmpegPath,
        masterAbs: destAbs,
      });
      burnDetail = burned.detail;
      if (burned.burned) {
        console.log(`[live-comments] ${recordingId} ${burnDetail}`);
      } else if (!burned.ok) {
        console.warn(`[live-comments] ${recordingId} burn failed: ${burnDetail}`);
      }
    } catch (err) {
      burnDetail = err instanceof Error ? err.message : String(err);
      console.warn(`[live-comments] ${recordingId} burn error: ${burnDetail}`);
    }
  }

  const finalBytes = await fileSize(destAbs);
  // Never mark bitti/enqueue analysis with a missing master after we had capture bytes.
  if (finalBytes < 64_000) {
    const msg = `Finalize master missing/empty (had ${hadBytes} bytes on part) · ${burnDetail}`;
    console.error(`[live-capture] ${recordingId} ${msg}`);
    await sql`
      UPDATE live_captures
      SET status = 'failed', last_probe_detail = ${msg}, updated_at = now()
      WHERE recording_id = ${recordingId}
    `;
    await sql`
      UPDATE recordings
      SET status = 'failed',
          capture_status = 'hata',
          capture_error = ${msg},
          error_message = ${msg},
          capture_ended_at = now(),
          capture_bytes = ${hadBytes},
          file_size_bytes = ${hadBytes},
          updated_at = now()
      WHERE id = ${recordingId}
    `;
    return;
  }

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
  const [cCount] = await sql<{ n: string }[]>`
    SELECT COUNT(*)::text AS n FROM observed_comments
    WHERE recording_id = ${recordingId}
      AND source IN ('live_api', 'live_dom')
  `;
  const liveApiN = Number(cCount?.n ?? 0);
  const commentsWarning =
    liveApiN === 0 ? "Yorum yok" : null;
  if (liveApiN === 0) {
    console.error(
      `[live-comments] ${recordingId} finalized with 0 live comments — cannot backfill after live ends`,
    );
  }
  const probeDetail = `${syncDetail} · comments=${liveApiN} · ${burnDetail}`;
  await sql`
    UPDATE live_captures
    SET status = 'completed',
        last_probe_detail = ${probeDetail},
        comments_warning = ${commentsWarning},
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
    `[live-capture] finalized ${recordingId} bytes=${finalBytes} exit=${code} comments=${liveApiN}`,
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
  const pinnedWatch =
    probe.ok && probe.broadcastId
      ? watchUrlWithBroadcastId(row.watch_url, probe.broadcastId)
      : row.watch_url;
  await sql`
    UPDATE live_captures
    SET attempt_count = attempt_count + 1,
        last_probe_at = now(),
        last_probe_detail = ${probe.ok ? probe.detail : probe.detail},
        watch_url = ${pinnedWatch},
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
    pinnedWatch,
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
    viewerPresence: getLiveViewerPresenceHealth(),
  };
}

export async function liveCaptureLoop(sql: Sql, env: AppEnv) {
  if (loopStarted) return;
  loopStarted = true;
  supervisorStartedAt = new Date().toISOString();
  console.log("[live-capture] supervisor started");

  // Resume in-flight captures: enforce max duration / finalize orphans first.
  await sql`
    UPDATE live_captures
    SET status = 'waiting', process_pid = NULL, updated_at = now()
    WHERE status = 'pending'
  `;
  await tickRecordingWatchdogs(sql, env);

  for (;;) {
    try {
      supervisorTickCount += 1;
      supervisorLastTickAt = new Date().toISOString();
      supervisorLastError = null;

      // Always enforce max minutes + orphan finalize (do not rely only on ffmpeg -t)
      await tickRecordingWatchdogs(sql, env);

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

/**
 * Loud warning when kaydediliyor for N+ minutes with 0 live comments,
 * or when comments freeze (0 new for COMMENT_FREEZE_MINUTES while live).
 * Sets live_captures.comments_warning for UI badges.
 */
export async function warnCommentDroughtIfNeeded(
  sql: Sql,
  recordingId: string,
  captureStartedAt: Date | string | null | undefined,
): Promise<boolean> {
  if (!captureStartedAt) return false;
  const startedMs = new Date(captureStartedAt).getTime();
  if (!Number.isFinite(startedMs)) return false;
  const elapsedMin = (Date.now() - startedMs) / 60_000;
  if (elapsedMin < COMMENT_DROUGHT_MINUTES) return false;

  const [row] = await sql<{ n: string; last_at: Date | string | null }[]>`
    SELECT COUNT(*)::text AS n,
           MAX(coalesce(observed_at, created_at)) AS last_at
    FROM observed_comments
    WHERE recording_id = ${recordingId}
      AND source IN ('live_api', 'live_dom')
  `;
  const n = Number(row?.n ?? 0);
  const viewer = getLiveViewerSession(recordingId)?.getHealth();
  const lastHitAt =
    viewer?.lastCommentHitAt ??
    (row?.last_at ? new Date(row.last_at).getTime() : null);

  if (n === 0) {
    const msg = `Yorum yok — ${Math.floor(elapsedMin)}dk kaydediliyor, live=0 (viewer/poll kontrol et)`;
    console.error(`[live-comments] DROUGHT ${recordingId}: ${msg}`);
    try {
      await sql`
        UPDATE live_captures
        SET comments_warning = ${"Yorum yok"},
            last_probe_detail = ${msg},
            updated_at = now()
        WHERE recording_id = ${recordingId}
          AND status IN ('recording', 'finalizing')
      `;
    } catch (err) {
      console.warn(
        `[live-comments] drought update failed:`,
        err instanceof Error ? err.message : err,
      );
    }
    return true;
  }

  // Tighten: comments existed but froze while still live
  if (
    lastHitAt != null &&
    Number.isFinite(lastHitAt) &&
    (Date.now() - lastHitAt) / 60_000 >= COMMENT_FREEZE_MINUTES &&
    viewer &&
    viewer.lastHeartbeatOk &&
    !viewer.broadcastEnded
  ) {
    const ageMin = Math.floor((Date.now() - lastHitAt) / 60_000);
    const warn = `Yorum durgun — son yorum ${ageMin}dk önce (${n} toplam)`;
    console.warn(`[live-comments] FREEZE ${recordingId}: ${warn}`);
    try {
      await sql`
        UPDATE live_captures
        SET comments_warning = ${warn},
            last_probe_detail = ${warn},
            updated_at = now()
        WHERE recording_id = ${recordingId}
          AND status IN ('recording', 'finalizing')
      `;
    } catch (err) {
      console.warn(
        `[live-comments] freeze warn failed:`,
        err instanceof Error ? err.message : err,
      );
    }
    return true;
  }

  return false;
}

async function tickRecordingWatchdogs(
  sql: Sql,
  env: AppEnv,
  opts?: { allowPart2?: boolean },
) {
  const rows = await sql<{
    recording_id: string;
    watch_url: string;
    process_pid: number | null;
    max_duration_minutes: number | null;
    max_bytes: number | null;
    capture_started_at: Date | null;
    lc_status: string;
    lc_updated_at: Date;
  }[]>`
    SELECT lc.recording_id, lc.watch_url, lc.process_pid, lc.max_duration_minutes,
           lc.max_bytes, r.capture_started_at,
           lc.status AS lc_status, lc.updated_at AS lc_updated_at
    FROM live_captures lc
    JOIN recordings r ON r.id = lc.recording_id
    WHERE lc.status IN ('recording', 'finalizing')
       OR r.capture_status = 'kaydediliyor'
  `;
  for (const row of rows) {
    dropDeadActiveProc(row.recording_id);
    const result = await enforceRecordingWatchdog(sql, env, row, opts);
    if (result === "finalized" || result === "part2") continue;

    const alive =
      activeProcs.has(row.recording_id) ||
      pidAlive(row.process_pid != null ? Number(row.process_pid) : null);
    if (alive) {
      // ffmpeg still running — ensure viewer+comment poll WITHOUT killing a healthy session
      attachViewerPresence(sql, env, {
        recordingId: row.recording_id,
        watchUrl: row.watch_url,
        username: usernameFromWatchUrl(row.watch_url) ?? undefined,
        broadcastId: extractBroadcastIdFromUrl(row.watch_url),
        mode: "ensure",
      });
      await warnCommentDroughtIfNeeded(sql, row.recording_id, row.capture_started_at);
    } else {
      // Dead with no usable media — leave waiting only if still flagged recording
      const st = await sql<{ status: string }[]>`
        SELECT status FROM live_captures WHERE recording_id = ${row.recording_id}
      `;
      if (st[0]?.status === "recording") {
        await sql`
          UPDATE live_captures
          SET status = 'waiting', process_pid = NULL,
              last_probe_detail = ${"ffmpeg bitti / yok — yeniden bekleniyor"},
              updated_at = now()
          WHERE recording_id = ${row.recording_id}
        `;
        await sql`
          UPDATE recordings
          SET status = 'awaiting_live', capture_status = 'bekleniyor', updated_at = now()
          WHERE id = ${row.recording_id} AND source_type = 'live'
            AND status IN ('recording', 'awaiting_live')
        `;
      }
    }
  }
}

/** External / oneshot stall tick (systemd capture-stall-watchdog). */
export async function runCaptureStallWatchdogTick(
  sql: Sql,
  env: AppEnv,
  opts?: { allowPart2?: boolean },
) {
  // Out-of-process: finalize/reclaim only — part2 must be owned by the API process.
  await tickRecordingWatchdogs(sql, env, {
    allowPart2: opts?.allowPart2 ?? false,
  });
}
