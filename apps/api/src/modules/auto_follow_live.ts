/**
 * Auto-capture lives from accounts followed by the watcher IG session.
 *
 * When enabled: at three Europe/Istanbul evening slots (20:05, 21:05, 22:05)
 * poll following-lives → createLiveCapture → live ends → finalize → analysis.
 * Manual "Canlı yayın ekle" remains available anytime.
 *
 * Outside those slots: no tray / following / profile probe sweeps for
 * auto-follow. Hard rule: while ANY capture is bekleniyor/kaydediliyor
 * (or live_captures in-flight), skip the slot scan entirely (scanPaused)
 * and never enqueue a second concurrent auto recording.
 */
import { mkdir, readFile, rename, writeFile, chmod } from "node:fs/promises";
import { resolve } from "node:path";
import type { Sql } from "@mezatizle/db";
import type { AppEnv } from "../lib/env.ts";
import { createLiveCapture } from "./live_capture.ts";
import {
  pollFollowingLives,
  type FollowingLive,
  loadFollowingCache,
  defaultProbeBatchSize,
  formatSweepEtaTr,
  normalizePriorityUsernames,
} from "./ig_following_lives.ts";
import {
  extractBroadcastIdFromUrl,
  whoamiIgCookies,
} from "./ig_live_playwright.ts";
import {
  getIgCookieUsername,
  getIgSessionStatus,
} from "./ig_session.ts";

const CONFIG_FILE = "auto-follow-live.json";
/**
 * Soft boost only — earlier in the full-following rotation order.
 * Coverage is the persisted following cache, not this tiny list.
 */
const DEFAULT_PRIORITY_USERNAMES = [
  "afra.vintagetaki",
  "glamvintage_",
  "glamvintage",
  "nunusvintageshop",
];

/**
 * Legacy clamp retained for within-slot probe ETA / config compat.
 * Auto-follow no longer continuous-polls on this interval.
 */
export const POLL_MS_MIN = 300_000;
export const POLL_MS_MAX = 360_000;
export const POLL_MS_DEFAULT = 330_000;
/** While a recording is active, re-check DB this often (no IG hit). */
export const PAUSE_RECHECK_MS = 30_000;
/** Idle wait while disabled / waiting for next evening slot (responsive toggle). */
export const SCHEDULER_IDLE_CHUNK_MS = 60_000;
/**
 * Hard ceiling for one IG poll (Playwright). Allows following refresh +
 * rotating profile probes without hanging forever after a stuck 429.
 */
export const POLL_HARD_TIMEOUT_MS = 120_000;
/**
 * After a scheduled slot time, allow this long to fire the poll once
 * (covers scheduler wake jitter). Then wait for the next slot.
 */
export const SLOT_FIRE_GRACE_MS = 120_000;
/** Loud alert if a due evening slot was missed by more than this. */
export const SLOT_MISS_ALERT_MS = 10 * 60_000;

/** Ban-safer evening-only auto-follow windows (fixed TRT / Europe/Istanbul). */
export const SCAN_TIMEZONE = "Europe/Istanbul";
/** Turkey observes permanent UTC+3 (no DST) — used for wall-clock math. */
export const ISTANBUL_UTC_OFFSET_MS = 3 * 60 * 60 * 1000;
export const SCAN_SLOTS_HM = [
  { hour: 20, minute: 5 },
  { hour: 21, minute: 5 },
  { hour: 22, minute: 5 },
] as const;
export const SCAN_SLOT_LABELS_TR = "20:05, 21:05, 22:05";

export type IstanbulWall = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

export function utcToIstanbulWall(date: Date): IstanbulWall {
  const t = new Date(date.getTime() + ISTANBUL_UTC_OFFSET_MS);
  return {
    year: t.getUTCFullYear(),
    month: t.getUTCMonth() + 1,
    day: t.getUTCDate(),
    hour: t.getUTCHours(),
    minute: t.getUTCMinutes(),
    second: t.getUTCSeconds(),
  };
}

export function istanbulWallToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second = 0,
): Date {
  return new Date(
    Date.UTC(year, month - 1, day, hour, minute, second) - ISTANBUL_UTC_OFFSET_MS,
  );
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function slotKeyFor(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): string {
  return `${year}-${pad2(month)}-${pad2(day)}T${pad2(hour)}:${pad2(minute)}`;
}

/**
 * If `now` falls inside a slot's fire grace window, return that slot key.
 */
export function currentDueSlotKey(
  now: Date = new Date(),
): string | null {
  const p = utcToIstanbulWall(now);
  const nowMs =
    ((p.hour * 60 + p.minute) * 60 + p.second) * 1000;
  for (const slot of SCAN_SLOTS_HM) {
    const slotMs = (slot.hour * 60 + slot.minute) * 60 * 1000;
    const delta = nowMs - slotMs;
    if (delta >= 0 && delta < SLOT_FIRE_GRACE_MS) {
      return slotKeyFor(p.year, p.month, p.day, slot.hour, slot.minute);
    }
  }
  return null;
}

/**
 * Next evening scan instant (Europe/Istanbul). If currently inside a slot's
 * grace window, returns that slot's start (still "due").
 */
export function nextEveningScanAt(now: Date = new Date()): Date {
  const p = utcToIstanbulWall(now);
  for (let dayOffset = 0; dayOffset <= 1; dayOffset++) {
    const base = istanbulWallToUtc(p.year, p.month, p.day, 12, 0);
    const day = utcToIstanbulWall(
      new Date(base.getTime() + dayOffset * 24 * 60 * 60_000),
    );
    for (const slot of SCAN_SLOTS_HM) {
      const at = istanbulWallToUtc(
        day.year,
        day.month,
        day.day,
        slot.hour,
        slot.minute,
      );
      const age = now.getTime() - at.getTime();
      if (age <= 0) return at;
      if (age < SLOT_FIRE_GRACE_MS) return at;
    }
  }
  // Fallback: day+2 first slot (should be unreachable)
  const next = utcToIstanbulWall(
    new Date(
      istanbulWallToUtc(p.year, p.month, p.day, 12, 0).getTime() +
        2 * 24 * 60 * 60_000,
    ),
  );
  const first = SCAN_SLOTS_HM[0]!;
  return istanbulWallToUtc(
    next.year,
    next.month,
    next.day,
    first.hour,
    first.minute,
  );
}

export function formatScanAtIstanbulTr(date: Date): string {
  const p = utcToIstanbulWall(date);
  return `${pad2(p.day)}.${pad2(p.month)}.${p.year} ${pad2(p.hour)}:${pad2(p.minute)} (İstanbul)`;
}

export function eveningScheduleHintTr(): string {
  return `Otomatik tarama günde 3 kez: ${SCAN_SLOT_LABELS_TR} Europe/Istanbul. Dışında IG takip taraması yok; manuel «Canlı yayın ekle» her zaman açık.`;
}

/**
 * Legacy helper: rate-limit backoff still used if a slot poll 429s and the
 * next slot is sooner than the backoff (unusual). Otherwise loop sleeps to
 * the next evening slot.
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
  const jittered = base + (rnd() - 0.5) * 60_000;
  return Math.floor(Math.min(POLL_MS_MAX, Math.max(POLL_MS_MIN, jittered)));
}

/** @deprecated continuous poll removed — kept for tests/compat */
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
  /** Soft boost order only — not the coverage set. */
  priorityUsernames: string[];
  /** Watcher following list size (persisted cache). */
  followingCount: number;
  /** When the rotating probe last wrapped the full following set. */
  lastFullSweepAt: string | null;
  /** When friendships/following list was last refreshed from IG. */
  lastFollowingRefreshAt: string | null;
  /** Profile probes per IG poll cycle. */
  probeBatchSize: number;
  /** Turkish ETA for one full following sweep (IG cycles; pauses while recording). */
  fullSweepEtaTr: string;
  lastProbeBatch: string[];
  /** ISO time of next evening auto-follow scan (Europe/Istanbul slots). */
  nextScanAt: string;
  /** e.g. "20:05, 21:05, 22:05" */
  scanWindowsTr: string;
  scanTimezone: string;
  scheduleHintTr: string;
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
  const followingCache = await loadFollowingCache(env);
  const probeBatchSize = defaultProbeBatchSize();
  const fullSweepEtaTr = formatSweepEtaTr(
    followingCache.usernames.length,
    probeBatchSize,
    s.pollIntervalMs,
  );
  const nextAt = nextEveningScanAt();
  const nextScanAt = nextAt.toISOString();
  const scheduleHintTr = eveningScheduleHintTr();
  let healthAlertTr: string | null = null;
  if (s.enabled) {
    if (!cookiesReady) {
      healthAlertTr =
        "Takip canlı taraması durdu: Instagram çerezi yok — Ayarlar → Instagram oturumu.";
    } else if (!loopStarted) {
      healthAlertTr =
        "Takip canlı poller çalışmıyor (API restart / AUTO_FOLLOW_LIVE=0).";
    } else if (!scanPaused) {
      // Missed-slot alert: most recent slot start + grace + miss window passed
      // without a poll at/after that slot.
      const p = utcToIstanbulWall(new Date());
      let mostRecentSlotAt: Date | null = null;
      for (const slot of SCAN_SLOTS_HM) {
        const at = istanbulWallToUtc(
          p.year,
          p.month,
          p.day,
          slot.hour,
          slot.minute,
        );
        if (at.getTime() <= Date.now()) mostRecentSlotAt = at;
      }
      if (
        mostRecentSlotAt &&
        Date.now() - mostRecentSlotAt.getTime() >
          SLOT_FIRE_GRACE_MS + SLOT_MISS_ALERT_MS
      ) {
        const last = s.lastPollAt ? new Date(s.lastPollAt).getTime() : 0;
        if (!Number.isFinite(last) || last < mostRecentSlotAt.getTime()) {
          healthAlertTr = `Akşam tarama penceresi kaçırıldı — son plan ${formatScanAtIstanbulTr(mostRecentSlotAt)}${s.lastError ? ` (${s.lastError})` : ""}.`;
        }
      }
      // Surface fresh 429/cookie failures only near/after a due slot (not all day).
      const due = currentDueSlotKey();
      if (
        !healthAlertTr &&
        due &&
        s.lastPollOk === false &&
        s.lastError &&
        /429|rate-limit|çerez|oturum|blocked|401|403/i.test(s.lastError)
      ) {
        healthAlertTr = `Takip canlı uyarısı: ${s.lastError}`;
      }
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
      `İzleyici hesabının (${watcherLabel}) takip ettiği TÜM hesaplar akşam pencerelerinde taranır (${SCAN_SLOT_LABELS_TR} İstanbul): önce reels_tray, sonra takip listesinden dönen profil yoklaması (pencere başına ~${probeBatchSize} hesap; tam tur ${fullSweepEtaTr} — kayıt sürerken pencereler atlanır). Küçük «öncelik» listesi yalnızca sırayı öne alır. Aynı anda tek kayıt; operatör «Kaydı kes» ile erken bitirip yenisini başlatabilir. Manuel «Canlı yayın ekle» her zaman açık.`,
    cookiesReady,
    watcherUsername,
    healthOk: !healthAlertTr,
    healthAlertTr,
    priorityUsernames,
    followingCount: followingCache.usernames.length,
    lastFullSweepAt: followingCache.lastFullSweepAt,
    lastFollowingRefreshAt: followingCache.refreshedAt,
    probeBatchSize,
    fullSweepEtaTr,
    lastProbeBatch: followingCache.lastProbeBatch,
    nextScanAt,
    scanWindowsTr: SCAN_SLOT_LABELS_TR,
    scanTimezone: SCAN_TIMEZONE,
    scheduleHintTr,
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
  const probeBatchSize = defaultProbeBatchSize();
  const result = await Promise.race([
    poll(env, {
      priorityUsernames,
      probeBatchSize,
      pollIntervalMs: stateBefore.pollIntervalMs,
    }),
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
    `[auto-follow] supervisor started (evening slots ${SCAN_SLOT_LABELS_TR} ${SCAN_TIMEZONE})`,
  );

  let lastWhoamiAt = 0;
  /** Slot keys already fired this process (avoid double-scan in grace). */
  const firedSlotKeys = new Set<string>();

  for (;;) {
    try {
      tickCount += 1;
      const state = await loadPersist(env);
      memoryStatus = state;

      if (!state.enabled) {
        state.lastDetail =
          "Takip canlı otomatik kayıt kapalı — akşam taraması yok.";
        await savePersist(env, state);
        memoryStatus = state;
        await Bun.sleep(SCHEDULER_IDLE_CHUNK_MS);
        continue;
      }

      const ig = await getIgSessionStatus(env);
      // Keep watcher label synced to cookie session (not stale credential mask).
      if (ig.hasCookies && Date.now() - lastWhoamiAt > 30 * 60_000) {
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
        await Bun.sleep(SCHEDULER_IDLE_CHUNK_MS);
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
        const due = currentDueSlotKey();
        if (due) firedSlotKeys.add(due); // skip this slot — do not thrash after recording ends mid-grace
        state.lastDetail = `Kayıt sürüyor (${who}) — takip taraması duraklatıldı. Sonraki: ${formatScanAtIstanbulTr(nextEveningScanAt(new Date(Date.now() + SLOT_FIRE_GRACE_MS)))}.`;
        state.lastError = null;
        await savePersist(env, state);
        memoryStatus = state;
        await Bun.sleep(PAUSE_RECHECK_MS);
        continue;
      }

      const dueKey = currentDueSlotKey();
      if (!dueKey || firedSlotKeys.has(dueKey)) {
        const nextAt = dueKey && firedSlotKeys.has(dueKey)
          ? nextEveningScanAt(new Date(Date.now() + SLOT_FIRE_GRACE_MS))
          : nextEveningScanAt();
        const wait = Math.max(1_000, nextAt.getTime() - Date.now());
        state.lastDetail = `Sonraki akşam taraması: ${formatScanAtIstanbulTr(nextAt)}. Pencereler: ${SCAN_SLOT_LABELS_TR}.`;
        state.lastError = null;
        await savePersist(env, state);
        memoryStatus = state;
        await Bun.sleep(Math.min(wait, SCHEDULER_IDLE_CHUNK_MS));
        continue;
      }

      console.log(`[auto-follow] evening slot fire ${dueKey}`);
      const cycle = await runAutoFollowPollCycle(sql, env);
      firedSlotKeys.add(dueKey);

      if (cycle.paused) {
        await Bun.sleep(PAUSE_RECHECK_MS);
        continue;
      }

      // 429: do not retry this slot; backoff is "wait until next evening slot"
      // (ban-safer than 5–6 min continuous). Intra-slot probe gaps remain in poller.
      if (/429|rate-limit/i.test(cycle.detail)) {
        const nextAt = nextEveningScanAt(
          new Date(Date.now() + SLOT_FIRE_GRACE_MS),
        );
        const rlSleep = nextPollSleepMs(state.pollIntervalMs, {
          rateLimited: true,
        });
        const untilNext = Math.max(1_000, nextAt.getTime() - Date.now());
        const sleepMs = Math.max(untilNext, rlSleep);
        state.lastDetail = `${cycle.detail} — sonraki deneme ${formatScanAtIstanbulTr(new Date(Date.now() + sleepMs))}.`;
        await savePersist(env, state);
        memoryStatus = state;
        await Bun.sleep(Math.min(sleepMs, SCHEDULER_IDLE_CHUNK_MS));
        continue;
      }

      const nextAt = nextEveningScanAt(
        new Date(Date.now() + SLOT_FIRE_GRACE_MS),
      );
      state.lastDetail = `Tarama tamam (${dueKey}). Sonraki: ${formatScanAtIstanbulTr(nextAt)}.`;
      await savePersist(env, state);
      memoryStatus = state;
      await Bun.sleep(
        Math.min(
          Math.max(1_000, nextAt.getTime() - Date.now()),
          SCHEDULER_IDLE_CHUNK_MS,
        ),
      );
    } catch (err) {
      console.error("[auto-follow] tick error", err);
      const state = await loadPersist(env);
      state.lastError = err instanceof Error ? err.message : String(err);
      state.lastPollOk = false;
      state.lastPollAt = new Date().toISOString();
      await savePersist(env, state);
      memoryStatus = state;
      await Bun.sleep(SCHEDULER_IDLE_CHUNK_MS);
    }
  }
}
