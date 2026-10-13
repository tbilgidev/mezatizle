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
  setIgSessionLastError,
  ytDlpAuthArgs,
} from "./ig_session.ts";

export const LIVE_CAPTURE_POLICY = {
  status: "operator_session_optional" as const,
  playwright: "not_enabled",
  tools: ["yt-dlp", "ffmpeg"],
  message:
    "Canlı kayıt yt-dlp ile yapılır. Giriş gerektiren yayınlar için Ayarlar → Instagram oturumu (yedek hesap) altında çerez/oturum tanımlayın. Özel API veya bot aşımı yok.",
  restrictions: [
    "Özel / belgesiz Instagram API yok",
    "Anti-bot aşımı / CAPTCHA bypass yok",
    "Yalnızca operatörün verdiği yedek hesap oturumu (cookies veya kullanıcı/parola)",
    "Kayıt için yasal/izin yükümlülüğü operatörde",
  ],
  limitationTr:
    "Oturum yoksa Instagram çoğu canlıyı engeller. Ayarlar → Instagram oturumu bölümüne yedek hesabınızın cookies.txt dosyasını yükleyin; yt-dlp --cookies ile dener.",
  settingsPathTr: "Ayarlar → Instagram oturumu (yedek hesap)",
};

const activeProcs = new Map<string, ChildProcessWithoutNullStreams>();
let loopStarted = false;

function ytDlpBin() {
  return process.env.YT_DLP_PATH || "yt-dlp";
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
  | { ok: true; detail: string }
  | { ok: false; kind: "blocked" | "not_found" | "error"; detail: string };

export async function probePublicLive(
  env: AppEnv,
  watchUrl: string,
): Promise<ProbeResult> {
  const bin = ytDlpBin();
  const auth = await ytDlpAuthArgs(env);
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
    60_000,
  );
  const blob = `${r.stdout}\n${r.stderr}`;
  const low = blob.toLowerCase();

  if (
    low.includes("login required") ||
    low.includes("sign in") ||
    low.includes("rate-limit") ||
    low.includes("checkpoint") ||
    low.includes("consent") ||
    low.includes("http error 401") ||
    low.includes("http error 403") ||
    (low.includes("cookies") && r.code !== 0)
  ) {
    const detail = auth.length
      ? "Instagram erişim engeli — yedek oturum/çerezler geçersiz veya yetersiz olabilir (Ayarlar → Instagram oturumu)."
      : "Instagram giriş veya erişim engeli — Ayarlar → Instagram oturumu altına yedek hesap çerezlerini ekleyin.";
    await setIgSessionLastError(env, detail);
    return {
      ok: false,
      kind: "blocked",
      detail,
    };
  }

  if (
    low.includes("is not currently live") ||
    low.includes("not live") ||
    low.includes("unsupported url") ||
    low.includes("unable to extract") ||
    low.includes("no video formats") ||
    r.code !== 0
  ) {
    // Try formats listing as secondary signal
    if (r.code === 0 && r.stdout.trim().startsWith("{")) {
      try {
        const j = JSON.parse(r.stdout) as { is_live?: boolean; formats?: unknown[] };
        if (j.is_live || (j.formats && j.formats.length > 0)) {
          return { ok: true, detail: "stream_metadata_ok" };
        }
      } catch {
        /* fall through */
      }
    }
    return {
      ok: false,
      kind: "not_found",
      detail: "Aktif herkese açık canlı yayın bulunamadı.",
    };
  }

  return { ok: true, detail: "probe_ok" };
}

export async function createLiveCapture(
  sql: Sql,
  env: AppEnv,
  opts: { input: string; displayName?: string; notes?: string },
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
      status, max_bytes
    ) VALUES (
      ${id}, ${parsed.inputRaw}, ${parsed.kind}, ${parsed.username}, ${parsed.watchUrl},
      'waiting', ${maxBytes}
    )
  `;

  return {
    recordingId: id,
    username: parsed.username,
    watchUrl: parsed.watchUrl,
    captureStatus: "bekleniyor",
    policy: LIVE_CAPTURE_POLICY,
  };
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

async function startRecordingProcess(
  sql: Sql,
  env: AppEnv,
  recordingId: string,
  watchUrl: string,
  destAbs: string,
  maxBytes: number,
) {
  const partAbs = `${destAbs}.part.mp4`;
  try {
    await unlink(partAbs);
  } catch {
    /* ok */
  }

  const bin = ytDlpBin();
  const auth = await ytDlpAuthArgs(env);
  const args = [
    bin,
    "--ignore-config",
    "--no-playlist",
    "--no-warnings",
    "--no-part",
    ...auth,
    "-f",
    "best",
    "-o",
    partAbs,
    "--newline",
    watchUrl,
  ];

  const child = spawn(args[0]!, args.slice(1), {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PYTHONWARNINGS: "ignore" },
  });
  activeProcs.set(recordingId, child);

  await sql`
    UPDATE live_captures
    SET status = 'recording', process_pid = ${child.pid ?? null},
        updated_at = now(), last_probe_detail = ${"recording_started"}
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

  const sizeTimer = setInterval(() => {
    void (async () => {
      const bytes = await fileSize(partAbs);
      await sql`
        UPDATE recordings
        SET capture_bytes = ${bytes}, file_size_bytes = ${bytes}, updated_at = now()
        WHERE id = ${recordingId}
      `;
      if (bytes >= maxBytes) {
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
  await sql`
    UPDATE live_captures SET status = 'completed', updated_at = now()
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
      await sql`
        UPDATE live_captures SET status = 'waiting', updated_at = now()
        WHERE recording_id = ${recordingId}
      `;
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
  );
}

export async function liveCaptureLoop(sql: Sql, env: AppEnv) {
  if (loopStarted) return;
  loopStarted = true;
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
      const rows = await sql<{
        recording_id: string;
        watch_url: string;
        status: string;
        created_at: Date;
        max_bytes: number;
        attempt_count: number;
      }[]>`
        SELECT recording_id, watch_url, status, created_at, max_bytes, attempt_count
        FROM live_captures
        WHERE status IN ('pending', 'waiting')
        ORDER BY created_at ASC
        LIMIT 10
      `;
      for (const row of rows) {
        await tickCapture(sql, env, row);
      }
    } catch (err) {
      console.error("[live-capture] tick error", err);
    }
    await Bun.sleep(probeIntervalMs());
  }
}
