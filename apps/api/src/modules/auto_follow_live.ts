/**
 * Auto-capture lives from accounts followed by the watcher IG session.
 *
 * When enabled: poll following-lives → createLiveCapture (same supervisor
 * pipeline) → live ends → finalize MP4 → analysis. Manual "Canlı yayın ekle"
 * remains available. Dedupes by username / broadcast_id while kaydediliyor.
 */
import { mkdir, readFile, rename, writeFile, chmod } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Sql } from "@mezatizle/db";
import type { AppEnv } from "../lib/env.ts";
import { createLiveCapture } from "./live_capture.ts";
import {
  pollFollowingLives,
  type FollowingLive,
} from "./ig_following_lives.ts";
import { extractBroadcastIdFromUrl } from "./ig_live_playwright.ts";
import { getIgSessionStatus } from "./ig_session.ts";

const CONFIG_FILE = "auto-follow-live.json";

export type AutoFollowLiveConfig = {
  enabled: boolean;
  pollIntervalMs: number;
  updatedAt: string | null;
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
  tickCount: number;
  startedAt: string | null;
  labelTr: string;
  hintTr: string;
  cookiesReady: boolean;
};

type PersistState = AutoFollowLiveConfig & {
  lastPollAt?: string | null;
  lastPollOk?: boolean | null;
  lastError?: string | null;
  lastDetail?: string | null;
  lastLivesSeen?: Array<{ username: string; broadcastId: string | null }>;
};

function configPath(env: AppEnv) {
  return resolve(env.storageRoot, "config", CONFIG_FILE);
}

function defaultEnabled(): boolean {
  return process.env.AUTO_FOLLOW_LIVE !== "0";
}

function defaultPollMs(): number {
  const n = Number(process.env.AUTO_FOLLOW_LIVE_POLL_MS ?? "90000");
  if (!Number.isFinite(n)) return 90_000;
  return Math.min(180_000, Math.max(60_000, Math.floor(n)));
}

async function ensureConfigDir(env: AppEnv) {
  const dir = resolve(env.storageRoot, "config");
  await mkdir(dir, { recursive: true, mode: 0o755 });
  return dir;
}

async function loadPersist(env: AppEnv): Promise<PersistState> {
  try {
    const raw = await readFile(configPath(env), "utf8");
    const j = JSON.parse(raw) as Partial<PersistState>;
    return {
      enabled: typeof j.enabled === "boolean" ? j.enabled : defaultEnabled(),
      pollIntervalMs:
        typeof j.pollIntervalMs === "number" && Number.isFinite(j.pollIntervalMs)
          ? Math.min(180_000, Math.max(60_000, Math.floor(j.pollIntervalMs)))
          : defaultPollMs(),
      updatedAt: j.updatedAt ?? null,
      lastPollAt: j.lastPollAt ?? null,
      lastPollOk: j.lastPollOk ?? null,
      lastError: j.lastError ?? null,
      lastDetail: j.lastDetail ?? null,
      lastLivesSeen: Array.isArray(j.lastLivesSeen) ? j.lastLivesSeen : [],
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
  };
}

export async function setAutoFollowLiveConfig(
  env: AppEnv,
  patch: { enabled?: boolean; pollIntervalMs?: number },
): Promise<AutoFollowLiveStatus> {
  const cur = await loadPersist(env);
  if (typeof patch.enabled === "boolean") cur.enabled = patch.enabled;
  if (
    typeof patch.pollIntervalMs === "number" &&
    Number.isFinite(patch.pollIntervalMs)
  ) {
    cur.pollIntervalMs = Math.min(
      180_000,
      Math.max(60_000, Math.floor(patch.pollIntervalMs)),
    );
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
  if (sql) {
    const active = await listActiveLiveCaptures(sql);
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
  const labelTr = s.enabled
    ? "Takip canlıları otomatik kaydet: açık"
    : "Takip canlıları otomatik kaydet: kapalı";
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
    tickCount,
    startedAt,
    labelTr,
    hintTr:
      "İzleyici hesabının (nihan.dogansoy) takip ettiği hesaplar canlıya geçince otomatik kayıt başlar. Manuel «Canlı yayın ekle» çalışmaya devam eder.",
    cookiesReady: Boolean(ig.hasCookies) || ig.status === "yuklu",
  };
}

export type EnqueueFn = typeof createLiveCapture;

/**
 * One poll → enqueue cycle (injectable for tests / dry-run).
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
  discovered: FollowingLive[];
  enqueued: Array<{ username: string; recordingId: string | null; skipped?: string }>;
  detail: string;
}> {
  const poll = opts?.poll ?? pollFollowingLives;
  const enqueue = opts?.enqueue ?? createLiveCapture;
  const dryRun = Boolean(opts?.dryRun);

  const result = await poll(env);
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
  const needed = filterLivesNeedingCapture(result.lives, active);
  const enqueued: Array<{
    username: string;
    recordingId: string | null;
    skipped?: string;
  }> = [];

  for (const live of needed) {
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
    discovered: result.lives,
    enqueued,
    detail: result.detail,
  };
}

function sleepMsFor(state: PersistState, lastFailKind?: string | null): number {
  if (lastFailKind === "rate_limited") {
    return Math.max(state.pollIntervalMs, 180_000);
  }
  return state.pollIntervalMs;
}

export async function autoFollowLiveLoop(sql: Sql, env: AppEnv) {
  if (loopStarted) return;
  loopStarted = true;
  startedAt = new Date().toISOString();
  console.log("[auto-follow] supervisor started");

  let lastFailKind: string | null = null;

  for (;;) {
    try {
      tickCount += 1;
      const state = await loadPersist(env);
      memoryStatus = state;

      if (!state.enabled) {
        await Bun.sleep(state.pollIntervalMs);
        continue;
      }

      const ig = await getIgSessionStatus(env);
      if (!ig.hasCookies && ig.status !== "yuklu") {
        state.lastError =
          "Çerez yok — otomatik kayıt bekliyor (Ayarlar → Instagram oturumu).";
        state.lastDetail = state.lastError;
        await savePersist(env, state);
        memoryStatus = state;
        await Bun.sleep(state.pollIntervalMs);
        continue;
      }

      const cycle = await runAutoFollowPollCycle(sql, env);
      lastFailKind = cycle.discovered.length === 0 && !cycle.detail.includes("aktif canlı yok")
        ? null
        : lastFailKind;
      // Detect rate limit from detail
      if (/429|rate-limit/i.test(cycle.detail)) lastFailKind = "rate_limited";
      else if (cycle.enqueued.some((e) => e.recordingId)) lastFailKind = null;
      else lastFailKind = null;

      await Bun.sleep(sleepMsFor(state, lastFailKind));
    } catch (err) {
      console.error("[auto-follow] tick error", err);
      const state = await loadPersist(env);
      state.lastError = err instanceof Error ? err.message : String(err);
      state.lastPollOk = false;
      state.lastPollAt = new Date().toISOString();
      await savePersist(env, state);
      memoryStatus = state;
      await Bun.sleep(defaultPollMs());
    }
  }
}
