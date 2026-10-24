/**
 * Auto-capture lives from accounts followed by the watcher IG session.
 *
 * When enabled: poll following-lives → createLiveCapture (same supervisor
 * pipeline) → live ends → finalize MP4 → analysis. Manual "Canlı yayın ekle"
 * remains available.
 *
 * Politeness: poll every ~5–6 minutes (jitter). While any capture is
 * bekleniyor/kaydediliyor (or live_captures in-flight), pause the IG scan
 * entirely and never start a second concurrent recording.
 */
import { mkdir, readFile, rename, writeFile, chmod } from "node:fs/promises";
import { resolve } from "node:path";
import type { Sql } from "@mezatizle/db";
import type { AppEnv } from "../lib/env.ts";
import { createLiveCapture } from "./live_capture.ts";
import {
  pollFollowingLives,
  type FollowingLive,
} from "./ig_following_lives.ts";
import {
  extractBroadcastIdFromUrl,
  whoamiIgCookies,
} from "./ig_live_playwright.ts";
import {
  getIgCookieUsername,
  getIgSessionStatus,
} from "./ig_session.ts";
import { normalizePriorityUsernames } from "./ig_following_lives.ts";

const CONFIG_FILE = "auto-follow-live.json";
/**
 * Default sellers to profile-probe when reels_tray omits their live ring.
 * Always includes known mezat sellers Tolga trusts auto-record for.
 */
const DEFAULT_PRIORITY_USERNAMES = [
  "afra.vintagetaki",
  "glamvintage_",
  "glamvintage",
  "nunusvintageshop",
];

/** Min / max / default IG poll interval (5–6 minutes). */
export const POLL_MS_MIN = 300_000;
export const POLL_MS_MAX = 360_000;
export const POLL_MS_DEFAULT = 330_000;
/** While a recording is active, re-check DB this often (no IG hit). */
export const PAUSE_RECHECK_MS = 30_000;
/**
 * Hard ceiling for one IG poll (Playwright). Prevents the supervisor loop
 * from hanging forever after a stuck browser / 429 page load.
 */
export const POLL_HARD_TIMEOUT_MS = 90_000;
/**
 * If last successful/attempted poll is older than this while enabled and
 * not scan-paused, surface a loud "poller stuck" failure in Settings/sidebar.
 * (2× max interval + rate-limit backoff ≈ 12+6 min → use 20 min.)
 */
export const POLL_STALE_MS = 20 * 60_000;

export type AutoFollowLiveConfig = {
  enabled: boolean;
  pollIntervalMs: number;
  updatedAt: string | null;
  /** Extra usernames to profile-check when tray misses a live. */
  priorityUsernames: string[];
};

export type AutoFollowWatching = {
  username: string;
  recordingId: string;
  broadcastId: string | null;
  captureStatus: string | null;
};

export type AutoFollowLiveStatus = {
  enabled: boolean;
  pollIntervalMs: number;
  loopStarted: boolean;
  lastPollAt: string | null;
  lastPollOk: boolean | null;
  lastError: string | null;
  lastDetail: string | null;
  lastLivesSeen: Array<{
    username: string;
    broadcastId: string | null;
  }>;
  currentlyWatching: AutoFollowWatching[];
  scanPaused: boolean;
  tickCount: number;
  startedAt: string | null;
  labelTr: string;
  hintTr: string;
  cookiesReady: boolean;
  /** Cookie-session watcher (@username), when known. */
  watcherUsername: string | null;
  /** Loud failure for UI when poller/cookies unhealthy. */
  healthOk: boolean;
  healthAlertTr: string | null;
  priorityUsernames: string[];
};

type PersistState = AutoFollowLiveConfig & {
  lastPollAt?: string | null;
  lastPollOk?: boolean | null;
  lastError?: string | null;
  lastDetail?: string | null;
  lastLivesSeen?: Array<{ username: string; broadcastId: string | null }>;
  priorityUsernames?: string[];
};

function configPath(env: AppEnv) {
  return resolve(env.storageRoot, "config", CONFIG_FILE);
}

function defaultEnabled(): boolean {
  return process.env.AUTO_FOLLOW_LIVE !== "0";
}

export function clampPollIntervalMs(n: number): number {
  if (!Number.isFinite(n)) return POLL_MS_DEFAULT;
  return Math.min(POLL_MS_MAX, Math.max(POLL_MS_MIN, Math.floor(n)));
}

function defaultPollMs(): number {
  const n = Number(process.env.AUTO_FOLLOW_LIVE_POLL_MS ?? String(POLL_MS_DEFAULT));
  return clampPollIntervalMs(Number.isFinite(n) ? n : POLL_MS_DEFAULT);
}

/**
 * Sleep until next IG poll: random jitter in [5, 6] minutes around the
 * configured base. On rate-limit, sleep ≥ 12 minutes.
 */
export function nextPollSleepMs(
  baseMs: number,
  opts?: { rateLimited?: boolean; random?: () => number },
): number {
  const rnd = opts?.random ?? Math.random;
  if (opts?.rateLimited) {
    return Math.floor(POLL_MS_MAX * 2 + rnd() * 60_000);
  }
  const base = clampPollIntervalMs(baseMs);
  // ±30s around base, clamped to 5–6 min
  const jittered = base + (rnd() - 0.5) * 60_000;
  return Math.floor(Math.min(POLL_MS_MAX, Math.max(POLL_MS_MIN, jittered)));
}

async function ensureConfigDir(env: AppEnv) {
  const dir = resolve(env.storageRoot, "config");
  await mkdir(dir, { recursive: true, mode: 0o755 });
  return dir;
}

function mergePriorityUsernames(
  configured: unknown,
  lastLivesSeen?: Array<{ username: string; broadcastId: string | null }>,
): string[] {
  const fromConfig = normalizePriorityUsernames(configured);
  const fromDefault = normalizePriorityUsernames(DEFAULT_PRIORITY_USERNAMES);
  const fromRecent = normalizePriorityUsernames(
    (lastLivesSeen ?? []).map((l) => l.username),
  );
  return normalizePriorityUsernames([
    ...fromConfig,
    ...fromDefault,
    ...fromRecent,
  ]);
}

async function loadPersist(env: AppEnv): Promise<PersistState> {
  try {
    const raw = await readFile(configPath(env), "utf8");
    const j = JSON.parse(raw) as Partial<PersistState>;
    const lastLivesSeen = Array.isArray(j.lastLivesSeen) ? j.lastLivesSeen : [];
    return {
      enabled: typeof j.enabled === "boolean" ? j.enabled : defaultEnabled(),
      pollIntervalMs:
        typeof j.pollIntervalMs === "number" && Number.isFinite(j.pollIntervalMs)
          ? clampPollIntervalMs(j.pollIntervalMs)
          : defaultPollMs(),
      updatedAt: j.updatedAt ?? null,
      lastPollAt: j.lastPollAt ?? null,
      lastPollOk: j.lastPollOk ?? null,
      lastError: j.lastError ?? null,
      lastDetail: j.lastDetail ?? null,
      lastLivesSeen,
      priorityUsernames: mergePriorityUsernames(
        j.priorityUsernames,
        lastLivesSeen,
      ),
    };
  } catch {
    return {
      enabled: defaultEnabled(),
      pollIntervalMs: defaultPollMs(),
      updatedAt: null,
      lastPollAt: null,
      lastPollOk: null,
      lastError: null,
      lastDetail: null,
      lastLivesSeen: [],
      priorityUsernames: mergePriorityUsernames(null),
    };
  }
}

async function savePersist(env: AppEnv, state: PersistState) {
  await ensureConfigDir(env);
  const path = configPath(env);
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o644 });
  await rename(tmp, path);
  try {
    await chmod(path, 0o644);
  } catch {
    /* ignore */
  }
}

export type ActiveCaptureRef = {
  recordingId: string;
  username: string;
  broadcastId: string | null;
  status: string;
  captureStatus: string | null;
};

/**
 * True when any in-flight capture should pause the follow-live IG scan
 * and block starting another recording.
 */
export function hasBlockingActiveCapture(active: ActiveCaptureRef[]): boolean {
  return active.some(
    (a) =>
      a.captureStatus === "kaydediliyor" ||
      a.captureStatus === "bekleniyor" ||
      a.status === "recording" ||
      a.status === "waiting" ||
      a.status === "pending" ||
      a.status === "finalizing",
  );
}

/**
 * Pure dedup: skip if same username or same broadcast already in-flight.
 */
export function filterLivesNeedingCapture(
  discovered: FollowingLive[],
  active: ActiveCaptureRef[],
): FollowingLive[] {
  return discovered.filter((d) => {
    const u = d.username.toLowerCase();
    for (const a of active) {
      if (a.username.toLowerCase() === u) return false;
      if (
        d.broadcastId &&
        a.broadcastId &&
        String(d.broadcastId) === String(a.broadcastId)
      ) {
        return false;
      }
    }
    return true;
  });
}

export async function listActiveLiveCaptures(
  sql: Sql,
): Promise<ActiveCaptureRef[]> {
  const rows = await sql<{
    recording_id: string;
    username: string;
    watch_url: string | null;
    source_url: string | null;
    status: string;
    capture_status: string | null;
  }[]>`
    SELECT lc.recording_id, s.instagram_username AS username,
           lc.watch_url, r.source_url, lc.status, r.capture_status
    FROM live_captures lc
    JOIN recordings r ON r.id = lc.recording_id
    JOIN sellers s ON s.id = r.seller_id
    WHERE lc.status IN ('pending', 'waiting', 'recording', 'finalizing')
       OR r.capture_status IN ('bekleniyor', 'kaydediliyor')
       OR r.status IN ('awaiting_live', 'recording')
  `;
  return rows.map((r) => ({
    recordingId: r.recording_id,
    username: String(r.username || "").toLowerCase(),
    broadcastId:
      extractBroadcastIdFromUrl(r.watch_url || "") ||
      extractBroadcastIdFromUrl(r.source_url || ""),
    status: r.status,
    captureStatus: r.capture_status,
  }));
}

let loopStarted = false;
let startedAt: string | null = null;
let tickCount = 0;
let memoryStatus: PersistState | null = null;

export async function getAutoFollowLiveConfig(
  env: AppEnv,
): Promise<AutoFollowLiveConfig> {
  const s = await loadPersist(env);
  memoryStatus = s;
  return {
    enabled: s.enabled,
    pollIntervalMs: s.pollIntervalMs,
    updatedAt: s.updatedAt,
    priorityUsernames: s.priorityUsernames ?? mergePriorityUsernames(null),
  };
}

export async function setAutoFollowLiveConfig(
  env: AppEnv,
  patch: {
    enabled?: boolean;
    pollIntervalMs?: number;
    priorityUsernames?: string[];
  },
): Promise<AutoFollowLiveStatus> {
  const cur = await loadPersist(env);
  if (typeof patch.enabled === "boolean") cur.enabled = patch.enabled;
  if (
    typeof patch.pollIntervalMs === "number" &&
    Number.isFinite(patch.pollIntervalMs)
  ) {
    cur.pollIntervalMs = clampPollIntervalMs(patch.pollIntervalMs);
  }
  if (Array.isArray(patch.priorityUsernames)) {
    cur.priorityUsernames = mergePriorityUsernames(patch.priorityUsernames);
  }
  cur.updatedAt = new Date().toISOString();
  await savePersist(env, cur);
  memoryStatus = cur;
  return getAutoFollowLiveStatus(env, null);
}

export async function getAutoFollowLiveStatus(
  env: AppEnv,
  sql: Sql | null,
): Promise<AutoFollowLiveStatus> {
  const s = memoryStatus ?? (await loadPersist(env));
  memoryStatus = s;
  const ig = await getIgSessionStatus(env);
  let currentlyWatching: AutoFollowWatching[] = [];
  let scanPaused = false;
  if (sql) {
    const active = await listActiveLiveCaptures(sql);
    scanPaused = hasBlockingActiveCapture(active);
    currentlyWatching = active
      .filter(
        (a) =>
          a.status === "recording" ||
          a.captureStatus === "kaydediliyor" ||
          a.status === "waiting" ||
          a.captureStatus === "bekleniyor",
      )
      .map((a) => ({
        username: a.username,
        recordingId: a.recordingId,
        broadcastId: a.broadcastId,
        captureStatus: a.captureStatus,
      }));
  }
  const watcherUsername = await getIgCookieUsername(env);
  const watcherLabel = watcherUsername ?? "nihan.dogansoy";
  const labelTr = s.enabled
    ? "Takip canlıları otomatik kaydet: açık"
    : "Takip canlıları otomatik kaydet: kapalı";
  const cookiesReady = Boolean(ig.hasCookies) || ig.status === "yuklu";
  const priorityUsernames =
    s.priorityUsernames ?? mergePriorityUsernames(null);
  let healthAlertTr: string | null = null;
  if (s.enabled) {
    if (!cookiesReady) {
      healthAlertTr =
        "Takip canlı taraması durdu: Instagram çerezi yok — Ayarlar → Instagram oturumu.";
    } else if (!loopStarted) {
      healthAlertTr =
        "Takip canlı poller çalışmıyor (API restart / AUTO_FOLLOW_LIVE=0).";
    } else if (!scanPaused && s.lastPollAt) {
      const age = Date.now() - new Date(s.lastPollAt).getTime();
      if (Number.isFinite(age) && age > POLL_STALE_MS) {
        healthAlertTr = `Takip canlı poller takıldı — son tarama ${Math.round(age / 60_000)} dk önce${s.lastError ? ` (${s.lastError})` : ""}.`;
      }
    } else if (!scanPaused && !s.lastPollAt && startedAt) {
      const age = Date.now() - new Date(startedAt).getTime();
      if (Number.isFinite(age) && age > POLL_STALE_MS) {
        healthAlertTr =
          "Takip canlı poller henüz tarama yapamadı — kontrol edin.";
      }
    }
    // Surface recent cookie/429 failures only while we should be polling
    // (not while scan is paused for an active kaydediliyor).
    if (
      !healthAlertTr &&
      !scanPaused &&
      s.lastPollOk === false &&
      s.lastError &&
      /429|rate-limit|çerez|oturum|blocked|401|403/i.test(s.lastError)
    ) {
      healthAlertTr = `Takip canlı uyarısı: ${s.lastError}`;
    }
  }
  return {
    enabled: s.enabled,
    pollIntervalMs: s.pollIntervalMs,
    loopStarted,
    lastPollAt: s.lastPollAt ?? null,
    lastPollOk: s.lastPollOk ?? null,
    lastError: s.lastError ?? null,
    lastDetail: s.lastDetail ?? null,
    lastLivesSeen: s.lastLivesSeen ?? [],
    currentlyWatching,
    scanPaused,
    tickCount,
    startedAt,
    labelTr,
    hintTr:
      `İzleyici hesabının (${watcherLabel}) takip ettiği hesaplar canlıya geçince otomatik kayıt başlar. Tarama ~5–6 dk’da bir; tepsi boş/429 olsa bile öncelik profilleri (afra, glamvintage_, …) yoklanır. Kayıt sürerken tarama durur — aynı anda tek kayıt. Manuel «Canlı yayın ekle» aynı kullanıcı/broadcast için çift başlatmaz.`,
    cookiesReady,
    watcherUsername,
    healthOk: !healthAlertTr,
    healthAlertTr,
    priorityUsernames,
  };
}

export type EnqueueFn = typeof createLiveCapture;

/**
 * One poll → enqueue cycle (injectable for tests / dry-run).
 * When a capture is already active and dryRun is false, skips the IG scan
 * entirely and does not enqueue.
 */
export async function runAutoFollowPollCycle(
  sql: Sql,
  env: AppEnv,
  opts?: {
    poll?: typeof pollFollowingLives;
    enqueue?: EnqueueFn;
    dryRun?: boolean;
  },
): Promise<{
  polled: boolean;
  paused: boolean;
  discovered: FollowingLive[];
  enqueued: Array<{ username: string; recordingId: string | null; skipped?: string }>;
  detail: string;
}> {
  const poll = opts?.poll ?? pollFollowingLives;
  const enqueue = opts?.enqueue ?? createLiveCapture;
  const dryRun = Boolean(opts?.dryRun);

  const activeBefore = await listActiveLiveCaptures(sql);
  if (!dryRun && hasBlockingActiveCapture(activeBefore)) {
    const who =
      activeBefore
        .map((a) => `@${a.username}${a.captureStatus ? ` (${a.captureStatus})` : ""}`)
        .join(", ") || "kayıt";
    const detail = `Kayıt sürüyor (${who}) — takip taraması duraklatıldı.`;
    const state = await loadPersist(env);
    state.lastDetail = detail;
    state.lastError = null;
    await savePersist(env, state);
    memoryStatus = state;
    return {
      polled: false,
      paused: true,
      discovered: [],
      enqueued: [],
      detail,
    };
  }

  const stateBefore = await loadPersist(env);
  const priorityUsernames = mergePriorityUsernames(
    stateBefore.priorityUsernames,
    stateBefore.lastLivesSeen,
  );
  const result = await Promise.race([
    poll(env, { priorityUsernames }),
    new Promise<Awaited<ReturnType<typeof pollFollowingLives>>>((resolve) => {
      setTimeout(
        () =>
          resolve({
            ok: false,
            kind: "error",
            detail: `Takip canlı taraması zaman aşımı (${Math.round(POLL_HARD_TIMEOUT_MS / 1000)}s) — Playwright takılmış olabilir.`,
          }),
        POLL_HARD_TIMEOUT_MS,
      );
    }),
  ]);
  const state = await loadPersist(env);

  if (!result.ok) {
    state.lastPollAt = new Date().toISOString();
    state.lastPollOk = false;
    state.lastError = result.detail;
    state.lastDetail = result.detail;
    await savePersist(env, state);
    memoryStatus = state;
    return {
      polled: true,
      paused: false,
      discovered: [],
      enqueued: [],
      detail: result.detail,
    };
  }

  state.lastPollAt = new Date().toISOString();
  state.lastPollOk = true;
  state.lastError = null;
  state.lastDetail = result.detail;
  state.lastLivesSeen = result.lives.map((l) => ({
    username: l.username,
    broadcastId: l.broadcastId,
  }));
  await savePersist(env, state);
  memoryStatus = state;

  const active = await listActiveLiveCaptures(sql);
  if (!dryRun && hasBlockingActiveCapture(active)) {
    const detail =
      "Tarama sonrası kayıt bulundu — yeni otomatik kayıt başlatılmadı (tek eşzamanlı kayıt).";
    state.lastDetail = detail;
    await savePersist(env, state);
    memoryStatus = state;
    return {
      polled: true,
      paused: true,
      discovered: result.lives,
      enqueued: result.lives.map((l) => ({
        username: l.username,
        recordingId:
          active.find((a) => a.username === l.username)?.recordingId ?? null,
        skipped: "recording_active",
      })),
      detail,
    };
  }

  const needed = filterLivesNeedingCapture(result.lives, active);
  const enqueued: Array<{
    username: string;
    recordingId: string | null;
    skipped?: string;
  }> = [];

  // At most one new capture per cycle (never concurrent auto recordings).
  const toStart = dryRun ? needed : needed.slice(0, 1);

  for (const live of toStart) {
    if (dryRun) {
      enqueued.push({
        username: live.username,
        recordingId: null,
        skipped: "dry_run",
      });
      continue;
    }
    try {
      const input = live.broadcastId
        ? `https://www.instagram.com/${live.username}/live/?broadcast_id=${live.broadcastId}`
        : `@${live.username}`;
      const created = await enqueue(sql, env, {
        input,
        notes: `auto_follow: takip canlısı @${live.username}`,
        maxDurationMinutes: null,
      });
      enqueued.push({
        username: live.username,
        recordingId: created.recordingId,
      });
      console.log(
        `[auto-follow] started @${live.username} → ${created.recordingId}` +
          (live.broadcastId ? ` bid=${live.broadcastId}` : ""),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      enqueued.push({
        username: live.username,
        recordingId: null,
        skipped: msg.slice(0, 160),
      });
      console.warn(`[auto-follow] enqueue @${live.username}: ${msg}`);
    }
  }

  for (const live of needed.slice(toStart.length)) {
    enqueued.push({
      username: live.username,
      recordingId: null,
      skipped: "max_one_concurrent",
    });
  }

  // Also report already-active skips for clarity
  for (const live of result.lives) {
    if (needed.some((n) => n.username === live.username)) continue;
    enqueued.push({
      username: live.username,
      recordingId:
        active.find((a) => a.username === live.username)?.recordingId ?? null,
      skipped: "already_recording",
    });
  }

  return {
    polled: true,
    paused: false,
    discovered: result.lives,
    enqueued,
    detail: result.detail,
  };
}

export async function autoFollowLiveLoop(sql: Sql, env: AppEnv) {
  if (loopStarted) return;
  loopStarted = true;
  startedAt = new Date().toISOString();
  console.log(
    `[auto-follow] supervisor started (poll ${POLL_MS_MIN / 1000}–${POLL_MS_MAX / 1000}s jitter)`,
  );

  let lastFailKind: string | null = null;
  let lastWhoamiAt = 0;

  for (;;) {
    try {
      tickCount += 1;
      const state = await loadPersist(env);
      memoryStatus = state;

      if (!state.enabled) {
        await Bun.sleep(nextPollSleepMs(state.pollIntervalMs));
        continue;
      }

      const ig = await getIgSessionStatus(env);
      // Keep watcher label synced to cookie session (not stale credential mask).
      if (
        ig.hasCookies &&
        Date.now() - lastWhoamiAt > 30 * 60_000
      ) {
        lastWhoamiAt = Date.now();
        const who = await whoamiIgCookies(env).catch(() => null);
        if (who?.ok) {
          console.log(`[auto-follow] watcher cookies = @${who.username}`);
        } else if (who && !who.ok) {
          console.warn(`[auto-follow] whoami failed: ${who.detail}`);
        }
      }
      if (!ig.hasCookies && ig.status !== "yuklu") {
        state.lastError =
          "Çerez yok — otomatik kayıt bekliyor (Ayarlar → Instagram oturumu).";
        state.lastDetail = state.lastError;
        await savePersist(env, state);
        memoryStatus = state;
        await Bun.sleep(nextPollSleepMs(state.pollIntervalMs));
        continue;
      }

      // Pause IG scan entirely while any recording is in progress.
      const active = await listActiveLiveCaptures(sql);
      if (hasBlockingActiveCapture(active)) {
        const who =
          active
            .map(
              (a) =>
                `@${a.username}${a.captureStatus ? ` (${a.captureStatus})` : ""}`,
            )
            .join(", ") || "kayıt";
        state.lastDetail = `Kayıt sürüyor (${who}) — takip taraması duraklatıldı.`;
        state.lastError = null;
        await savePersist(env, state);
        memoryStatus = state;
        await Bun.sleep(PAUSE_RECHECK_MS);
        continue;
      }

      const cycle = await runAutoFollowPollCycle(sql, env);
      if (cycle.paused) {
        await Bun.sleep(PAUSE_RECHECK_MS);
        continue;
      }

      if (/429|rate-limit/i.test(cycle.detail)) lastFailKind = "rate_limited";
      else lastFailKind = null;

      await Bun.sleep(
        nextPollSleepMs(state.pollIntervalMs, {
          rateLimited: lastFailKind === "rate_limited",
        }),
      );
    } catch (err) {
      console.error("[auto-follow] tick error", err);
      const state = await loadPersist(env);
      state.lastError = err instanceof Error ? err.message : String(err);
      state.lastPollOk = false;
      state.lastPollAt = new Date().toISOString();
      await savePersist(env, state);
      memoryStatus = state;
      await Bun.sleep(nextPollSleepMs(defaultPollMs()));
    }
  }
}
