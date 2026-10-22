/**
 * Discover which accounts the watcher IG follows that are currently live.
 *
 * Uses operator cookies + Playwright same-origin web calls (reels_tray /
 * homepage signals). No private API kits, no credential stuffing.
 *
 * Politeness: one browser session per poll; default interval ~5–6 min
 * (caller jitter); on HTTP 429 back off harder (caller). Prefer reels_tray
 * (single request); when tray is empty/incomplete, rotate profile probes
 * across the **full persisted following list** (not a tiny hardcoded set).
 */
import { mkdir, readFile, rename, writeFile, chmod } from "node:fs/promises";
import { resolve } from "node:path";
import type { AppEnv } from "../lib/env.ts";
import { resolveCookiesPath } from "./ig_session.ts";

export type FollowingLive = {
  username: string;
  broadcastId: string | null;
  /** Public watch URL suitable for createLiveCapture / yt-dlp path. */
  watchUrl: string;
  viewerCount?: number | null;
};

export type FollowingLivesPollOk = {
  ok: true;
  lives: FollowingLive[];
  detail: string;
  source: "reels_tray" | "html_signals" | "mixed" | "following_probe";
  followingCount: number;
  lastFullSweepAt: string | null;
  lastFollowingRefreshAt: string | null;
  probedThisCycle: string[];
  probeCursor: number;
  completedSweep: boolean;
};

export type FollowingLivesPollFail = {
  ok: false;
  kind: "blocked" | "rate_limited" | "error" | "no_cookies";
  detail: string;
  followingCount?: number;
  lastFullSweepAt?: string | null;
  lastFollowingRefreshAt?: string | null;
};

export type FollowingLivesPollResult =
  | FollowingLivesPollOk
  | FollowingLivesPollFail;

/** Persist watcher following list + rotation cursor (config, not secrets). */
export const FOLLOWING_CACHE_FILE = "ig-following-cache.json";
/** Refresh friendships list this often (ban-safe; not every poll). */
export const FOLLOWING_CACHE_TTL_MS = 6 * 60 * 60_000;
/** Profile probes per poll cycle (spread full set across cycles). */
export const PROBE_BATCH_DEFAULT = 8;
export const PROBE_BATCH_MIN = 3;
export const PROBE_BATCH_MAX = 12;
/** Gap between web_profile_info probes (ms). */
export const PROBE_GAP_MS_MIN = 700;
export const PROBE_GAP_MS_MAX = 1400;

export type FollowingCacheState = {
  watcherUserId: string | null;
  usernames: string[];
  refreshedAt: string | null;
  probeCursor: number;
  lastFullSweepAt: string | null;
  lastProbeBatch: string[];
  updatedAt: string | null;
};

export function emptyFollowingCache(): FollowingCacheState {
  return {
    watcherUserId: null,
    usernames: [],
    refreshedAt: null,
    probeCursor: 0,
    lastFullSweepAt: null,
    lastProbeBatch: [],
    updatedAt: null,
  };
}

export function followingCachePath(env: AppEnv): string {
  return resolve(env.storageRoot, "config", FOLLOWING_CACHE_FILE);
}

export async function loadFollowingCache(
  env: AppEnv,
): Promise<FollowingCacheState> {
  try {
    const raw = await readFile(followingCachePath(env), "utf8");
    const j = JSON.parse(raw) as Partial<FollowingCacheState>;
    return {
      watcherUserId:
        typeof j.watcherUserId === "string" && /^\d{5,}$/.test(j.watcherUserId)
          ? j.watcherUserId
          : null,
      usernames: normalizeFollowingUsernames(j.usernames ?? []),
      refreshedAt: typeof j.refreshedAt === "string" ? j.refreshedAt : null,
      probeCursor:
        typeof j.probeCursor === "number" && Number.isFinite(j.probeCursor)
          ? Math.max(0, Math.floor(j.probeCursor))
          : 0,
      lastFullSweepAt:
        typeof j.lastFullSweepAt === "string" ? j.lastFullSweepAt : null,
      lastProbeBatch: normalizeFollowingUsernames(j.lastProbeBatch ?? []),
      updatedAt: typeof j.updatedAt === "string" ? j.updatedAt : null,
    };
  } catch {
    return emptyFollowingCache();
  }
}

export async function saveFollowingCache(
  env: AppEnv,
  state: FollowingCacheState,
): Promise<void> {
  const dir = resolve(env.storageRoot, "config");
  await mkdir(dir, { recursive: true, mode: 0o755 });
  const path = followingCachePath(env);
  const tmp = `${path}.tmp`;
  const payload: FollowingCacheState = {
    ...state,
    usernames: normalizeFollowingUsernames(state.usernames),
    lastProbeBatch: normalizeFollowingUsernames(state.lastProbeBatch),
    updatedAt: new Date().toISOString(),
  };
  await writeFile(tmp, JSON.stringify(payload, null, 2), { mode: 0o644 });
  await rename(tmp, path);
  try {
    await chmod(path, 0o644);
  } catch {
    /* ignore */
  }
}

/** Normalize full following list (larger than priority cap). */
export function normalizeFollowingUsernames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of raw) {
    if (typeof x !== "string") continue;
    const u = x.trim().replace(/^@/, "").toLowerCase();
    if (!/^[a-z0-9._]{1,30}$/.test(u) || seen.has(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out.slice(0, 2000);
}

export function clampProbeBatchSize(n: number): number {
  if (!Number.isFinite(n)) return PROBE_BATCH_DEFAULT;
  return Math.min(PROBE_BATCH_MAX, Math.max(PROBE_BATCH_MIN, Math.floor(n)));
}

export function defaultProbeBatchSize(): number {
  const n = Number(
    process.env.AUTO_FOLLOW_PROBE_BATCH ?? String(PROBE_BATCH_DEFAULT),
  );
  return clampProbeBatchSize(Number.isFinite(n) ? n : PROBE_BATCH_DEFAULT);
}

/**
 * Soft boost: priority sellers first in the rotation order, then the rest
 * of the following list. Priority alone is never the coverage set.
 */
export function orderFollowingForProbe(
  following: string[],
  priority: string[],
): string[] {
  const all = normalizeFollowingUsernames(following);
  const pri = new Set(normalizeFollowingUsernames(priority));
  const first = all.filter((u) => pri.has(u));
  const rest = all.filter((u) => !pri.has(u));
  return [...first, ...rest];
}

/** Take up to batchSize usernames starting at cursor (wraps). */
export function sliceRotated(
  ordered: string[],
  cursor: number,
  batchSize: number,
): string[] {
  if (!ordered.length || batchSize <= 0) return [];
  const size = Math.min(batchSize, ordered.length);
  const start =
    ((cursor % ordered.length) + ordered.length) % ordered.length;
  const out: string[] = [];
  for (let n = 0; n < size; n++) {
    out.push(ordered[(start + n) % ordered.length]!);
  }
  return out;
}

export function advanceProbeCursor(
  total: number,
  cursor: number,
  stepped: number,
): { nextCursor: number; completedSweep: boolean } {
  if (total <= 0) return { nextCursor: 0, completedSweep: false };
  const start = ((cursor % total) + total) % total;
  const step = Math.max(0, Math.min(stepped, total));
  const next = start + step;
  if (next >= total) {
    return { nextCursor: next % total, completedSweep: true };
  }
  return { nextCursor: next, completedSweep: false };
}

/**
 * ETA for one full following sweep (IG scan cycles only; pauses while recording).
 */
export function estimateFullSweepMinutes(
  followingCount: number,
  batchSize: number,
  pollIntervalMs: number,
): number {
  const batch = clampProbeBatchSize(batchSize);
  const count = Math.max(0, followingCount);
  if (count === 0) return 0;
  const cycles = Math.max(1, Math.ceil(count / batch));
  const mins = (cycles * Math.max(60_000, pollIntervalMs)) / 60_000;
  return Math.round(mins * 10) / 10;
}

export function formatSweepEtaTr(
  followingCount: number,
  batchSize: number,
  pollIntervalMs: number,
): string {
  const mins = estimateFullSweepMinutes(
    followingCount,
    batchSize,
    pollIntervalMs,
  );
  if (followingCount <= 0) return "takip listesi henüz yok";
  const batch = clampProbeBatchSize(batchSize);
  return `≈${mins} dk (her taramada ${batch} hesap; kayıt sırasında duraklar)`;
}

type CookieRow = {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  secure: boolean;
};

function parseNetscapeCookies(text: string): CookieRow[] {
  const out: CookieRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const parts = line.split("\t");
    if (parts.length < 7) continue;
    const [domain, , path, secure, expiry, name, value] = parts;
    if (!name || !domain || !value) continue;
    out.push({
      name,
      value,
      domain,
      path: path || "/",
      expires: Number(expiry) > 0 ? Number(expiry) : undefined,
      secure: String(secure).toUpperCase() === "TRUE",
    });
  }
  return out;
}

function watchUrlFor(username: string, broadcastId: string | null): string {
  const u = username.toLowerCase();
  const base = `https://www.instagram.com/${u}/live/`;
  return broadcastId ? `${base}?broadcast_id=${broadcastId}` : base;
}

function pushLive(
  map: Map<string, FollowingLive>,
  username: string | null | undefined,
  broadcastId: string | null | undefined,
  viewerCount?: number | null,
) {
  if (!username || !/^[a-z0-9._]{1,30}$/i.test(username)) return;
  const key = username.toLowerCase();
  const bid =
    broadcastId && /^\d{5,}$/.test(String(broadcastId))
      ? String(broadcastId)
      : null;
  const prev = map.get(key);
  if (prev) {
    if (!prev.broadcastId && bid) prev.broadcastId = bid;
    if (prev.viewerCount == null && viewerCount != null) {
      prev.viewerCount = viewerCount;
    }
    prev.watchUrl = watchUrlFor(key, prev.broadcastId);
    return;
  }
  map.set(key, {
    username: key,
    broadcastId: bid,
    watchUrl: watchUrlFor(key, bid),
    viewerCount: viewerCount ?? null,
  });
}

/**
 * Pure parser — unit-tested. Accepts Instagram reels_tray JSON (web or app shape).
 */
export function parseReelsTrayLives(payload: unknown): FollowingLive[] {
  const map = new Map<string, FollowingLive>();
  if (!payload || typeof payload !== "object") return [];

  const root = payload as Record<string, unknown>;
  const trays: unknown[] = [];
  for (const key of ["tray", "broadcasts", "items", "story_tray"]) {
    const v = root[key];
    if (Array.isArray(v)) trays.push(...v);
  }

  const visit = (node: unknown, depth = 0) => {
    if (!node || typeof node !== "object" || depth > 8) return;
    if (Array.isArray(node)) {
      for (const x of node) visit(x, depth + 1);
      return;
    }
    const o = node as Record<string, unknown>;

    const user =
      (o.user as Record<string, unknown> | undefined) ||
      (o.owner as Record<string, unknown> | undefined) ||
      (o.broadcast_owner as Record<string, unknown> | undefined);
    const username =
      (typeof user?.username === "string" && user.username) ||
      (typeof o.username === "string" && o.username) ||
      null;

    const broadcast =
      (o.broadcast as Record<string, unknown> | undefined) ||
      (typeof o.id === "string" || typeof o.id === "number"
        ? o.broadcast_status || o.dash_playback_url
          ? o
          : undefined
        : undefined);

    const bidRaw =
      broadcast?.id ??
      o.live_broadcast_id ??
      o.broadcast_id ??
      (typeof o.id === "string" || typeof o.id === "number"
        ? o.broadcast_status
          ? o.id
          : null
        : null);

    const status = String(
      broadcast?.broadcast_status ?? o.broadcast_status ?? "",
    ).toLowerCase();
    const hasLiveSignal =
      Boolean(broadcast) ||
      Boolean(o.live_broadcast_id) ||
      status === "active" ||
      status === "interrupted" ||
      o.media_type === 4 || // IG live media type in some payloads
      o.is_live === true ||
      o.has_live === true;

    if (username && hasLiveSignal) {
      const viewers =
        typeof broadcast?.viewer_count === "number"
          ? broadcast.viewer_count
          : typeof o.viewer_count === "number"
            ? o.viewer_count
            : null;
      // Skip clearly ended
      if (status && status !== "active" && status !== "interrupted") {
        /* still may be tray ring — only skip terminated */
        if (/ended|stopped|hard_stop|complete/.test(status)) {
          /* skip */
        } else {
          pushLive(map, username, bidRaw != null ? String(bidRaw) : null, viewers);
        }
      } else {
        pushLive(map, username, bidRaw != null ? String(bidRaw) : null, viewers);
      }
    }

    for (const v of Object.values(o)) {
      if (v && typeof v === "object") visit(v, depth + 1);
    }
  };

  for (const t of trays) visit(t, 0);
  // Also walk root in case tray nesting differs
  if (!trays.length) visit(root, 0);

  return [...map.values()].sort((a, b) => a.username.localeCompare(b.username));
}

/**
 * Extract live rings from homepage / GraphQL HTML+JSON text blobs.
 */
export function parseHtmlLiveSignals(text: string): FollowingLive[] {
  const map = new Map<string, FollowingLive>();
  // "username":"foo" ... "live_broadcast_id":"123"
  const re = /"username"\s*:\s*"([A-Za-z0-9._]{1,30})"[\s\S]{0,500}?"live_broadcast_id"\s*:\s*"(\d{5,})"/gi;
  for (const m of text.matchAll(re)) {
    pushLive(map, m[1], m[2]);
  }
  // reverse order sometimes
  const re2 =
    /"live_broadcast_id"\s*:\s*"(\d{5,})"[\s\S]{0,500}?"username"\s*:\s*"([A-Za-z0-9._]{1,30})"/gi;
  for (const m of text.matchAll(re2)) {
    pushLive(map, m[2], m[1]);
  }
  // href="/user/live/" or full URL — tray HTML sometimes only exposes the path
  const re3 =
    /(?:instagram\.com|href=["'])\/([A-Za-z0-9._]{1,30})\/live\/?(?:\?[^"'<\s]*)?/gi;
  for (const m of text.matchAll(re3)) {
    pushLive(map, m[1], null);
  }
  return [...map.values()];
}

/** Normalize operator-configured priority usernames (soft boost only). */
export function normalizePriorityUsernames(raw: unknown): string[] {
  return normalizeFollowingUsernames(raw).slice(0, 40);
}

function cookieValue(cookies: CookieRow[], name: string): string | null {
  const hit = cookies.find((c) => c.name === name);
  return hit?.value || null;
}

function cacheNeedsRefresh(cache: FollowingCacheState): boolean {
  if (!cache.usernames.length || !cache.refreshedAt) return true;
  const age = Date.now() - new Date(cache.refreshedAt).getTime();
  return !Number.isFinite(age) || age >= FOLLOWING_CACHE_TTL_MS;
}

let pollInFlight: Promise<FollowingLivesPollResult> | null = null;

/**
 * Poll Instagram (watcher cookies) for followed accounts that are live.
 */
export async function pollFollowingLives(
  env: AppEnv,
  opts?: {
    priorityUsernames?: string[];
    probeBatchSize?: number;
    pollIntervalMs?: number;
  },
): Promise<FollowingLivesPollResult> {
  if (pollInFlight) {
    try {
      return await pollInFlight;
    } catch {
      /* fall through to new poll */
    }
  }
  const run = doPollFollowingLives(env, opts);
  pollInFlight = run.finally(() => {
    pollInFlight = null;
  });
  return run;
}

async function doPollFollowingLives(
  env: AppEnv,
  opts?: {
    priorityUsernames?: string[];
    probeBatchSize?: number;
    pollIntervalMs?: number;
  },
): Promise<FollowingLivesPollResult> {
  const cookiesFile = await resolveCookiesPath(env);
  if (!cookiesFile) {
    return {
      ok: false,
      kind: "no_cookies",
      detail:
        "Çerez yok — otomatik takip kaydı için Ayarlar → Instagram oturumu gerekli.",
    };
  }
  let cookieText: string;
  try {
    cookieText = await readFile(cookiesFile, "utf8");
  } catch {
    return { ok: false, kind: "error", detail: "Çerez dosyası okunamadı." };
  }
  const cookies = parseNetscapeCookies(cookieText);
  if (!cookies.some((c) => c.name === "sessionid")) {
    return {
      ok: false,
      kind: "blocked",
      detail: "cookies.txt içinde sessionid yok.",
    };
  }

  let chromium: typeof import("playwright").chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    return {
      ok: false,
      kind: "error",
      detail: "Playwright yüklü değil.",
    };
  }

  let browser: import("playwright").Browser | null = null;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      locale: "tr-TR",
      viewport: { width: 1280, height: 720 },
    });
    await context.addCookies(
      cookies.map((c) => ({ ...c, sameSite: "Lax" as const })),
    );
    const page = await context.newPage();

    const home = await page.goto("https://www.instagram.com/", {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });
    // Homepage 429 must not abort — still refresh following cache + rotate
    // profile probes so tray-miss lives (e.g. nunus) are covered.
    let homeRateLimited = Boolean(home && home.status() === 429);
    if (/accounts\/login/i.test(page.url())) {
      return {
        ok: false,
        kind: "blocked",
        detail:
          "Çerezlerle giriş yapılamadı. Ayarlar → Instagram oturumu → cookies yenileyin.",
      };
    }
    await page.waitForTimeout(homeRateLimited ? 400 : 1200);

    const cache = await loadFollowingCache(env);
    const dsUserId = cookieValue(cookies, "ds_user_id");
    if (dsUserId) cache.watcherUserId = dsUserId;

    const trayResult = await page.evaluate(async () => {
      const csrf =
        document.cookie
          .split(";")
          .map((s) => s.trim())
          .find((s) => s.startsWith("csrftoken="))
          ?.split("=")[1] || "";
      const headers: Record<string, string> = {
        "X-IG-App-ID": "936619743392459",
        "X-Requested-With": "XMLHttpRequest",
        "X-CSRFToken": csrf,
        Accept: "*/*",
      };
      const urls = [
        "https://www.instagram.com/api/v1/feed/reels_tray/",
        "https://www.instagram.com/api/v1/live/get_live_settings/",
      ];
      const bodies: {
        url: string;
        status: number;
        json: unknown | null;
        text: string;
      }[] = [];
      for (const url of urls) {
        try {
          const r = await fetch(url, { credentials: "include", headers });
          const text = await r.text();
          let json: unknown | null = null;
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
          bodies.push({
            url,
            status: r.status,
            json,
            text: text.slice(0, 50_000),
          });
        } catch (err) {
          bodies.push({
            url,
            status: 0,
            json: null,
            text: err instanceof Error ? err.message : String(err),
          });
        }
      }
      const html = document.documentElement?.innerHTML?.slice(0, 200_000) || "";
      return { bodies, html };
    });

    const map = new Map<string, FollowingLive>();
    let source: FollowingLivesPollOk["source"] = "reels_tray";
    let rateLimited = homeRateLimited;
    let blocked = false;

    for (const b of trayResult.bodies) {
      if (b.status === 429) rateLimited = true;
      if (b.status === 401 || b.status === 403) blocked = true;
      if (b.json) {
        for (const live of parseReelsTrayLives(b.json)) {
          pushLive(map, live.username, live.broadcastId, live.viewerCount);
        }
      }
      if (b.text) {
        for (const live of parseHtmlLiveSignals(b.text)) {
          pushLive(map, live.username, live.broadcastId, live.viewerCount);
          source = map.size ? "mixed" : source;
        }
      }
    }

    const htmlLives = parseHtmlLiveSignals(trayResult.html || "");
    if (htmlLives.length) {
      for (const live of htmlLives) {
        pushLive(map, live.username, live.broadcastId, live.viewerCount);
      }
      source = map.size && source === "reels_tray" ? "mixed" : "html_signals";
    }

    // Refresh persisted following list periodically (paginated, polite).
    if (cacheNeedsRefresh(cache) && cache.watcherUserId) {
      const followingFetch = await page.evaluate(
        async (userId: string) => {
          const csrf =
            document.cookie
              .split(";")
              .map((s) => s.trim())
              .find((s) => s.startsWith("csrftoken="))
              ?.split("=")[1] || "";
          const headers: Record<string, string> = {
            "X-IG-App-ID": "936619743392459",
            "X-Requested-With": "XMLHttpRequest",
            "X-CSRFToken": csrf,
            Accept: "*/*",
          };
          const usernames: string[] = [];
          let maxId: string | null = null;
          let rateLimited = false;
          let blocked = false;
          let pages = 0;
          while (pages < 40) {
            const url =
              `https://www.instagram.com/api/v1/friendships/${userId}/following/?count=50` +
              (maxId ? `&max_id=${encodeURIComponent(maxId)}` : "");
            try {
              const r = await fetch(url, {
                credentials: "include",
                headers,
              });
              if (r.status === 429) {
                rateLimited = true;
                break;
              }
              if (r.status === 401 || r.status === 403) {
                blocked = true;
                break;
              }
              const j = (await r.json().catch(() => null)) as {
                users?: Array<{ username?: string }>;
                next_max_id?: string | number | null;
              } | null;
              for (const u of j?.users ?? []) {
                if (typeof u.username === "string") usernames.push(u.username);
              }
              const next = j?.next_max_id;
              if (next == null || next === "") break;
              maxId = String(next);
              pages += 1;
              await new Promise((res) =>
                setTimeout(res, 450 + Math.floor(Math.random() * 450)),
              );
            } catch {
              break;
            }
          }
          return { usernames, rateLimited, blocked, pages };
        },
        cache.watcherUserId,
      );
      if (followingFetch.rateLimited) rateLimited = true;
      if (followingFetch.blocked) blocked = true;
      const fetched = normalizeFollowingUsernames(followingFetch.usernames);
      if (fetched.length) {
        cache.usernames = fetched;
        cache.refreshedAt = new Date().toISOString();
        if (cache.probeCursor >= fetched.length) cache.probeCursor = 0;
      }
    }

    const priority = normalizePriorityUsernames(opts?.priorityUsernames);
    const batchSize = clampProbeBatchSize(
      opts?.probeBatchSize ?? defaultProbeBatchSize(),
    );
    const ordered = orderFollowingForProbe(cache.usernames, priority);
    // Fallback: if cache still empty, at least probe soft-priority once.
    const rotationBase = ordered.length ? ordered : priority;
    const window = sliceRotated(
      rotationBase,
      cache.probeCursor,
      batchSize,
    );
    const toProbe = window.filter((u) => !map.has(u));
    let completedSweep = false;
    let probedThisCycle: string[] = [];

    if (toProbe.length) {
      const probed = await page.evaluate(
        async (args: {
          usernames: string[];
          gapMin: number;
          gapMax: number;
        }) => {
          const csrf =
            document.cookie
              .split(";")
              .map((s) => s.trim())
              .find((s) => s.startsWith("csrftoken="))
              ?.split("=")[1] || "";
          const headers: Record<string, string> = {
            "X-IG-App-ID": "936619743392459",
            "X-Requested-With": "XMLHttpRequest",
            "X-CSRFToken": csrf,
            Accept: "*/*",
          };
          const out: Array<{
            username: string;
            broadcastId: string | null;
            status: number;
          }> = [];
          for (let i = 0; i < args.usernames.length; i++) {
            const uname = args.usernames[i]!;
            try {
              const r = await fetch(
                `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(uname)}`,
                { credentials: "include", headers },
              );
              const j = (await r.json().catch(() => null)) as {
                data?: { user?: { live_broadcast_id?: string | null } };
              } | null;
              const bid = j?.data?.user?.live_broadcast_id;
              out.push({
                username: uname,
                broadcastId:
                  typeof bid === "string" && /^\d{5,}$/.test(bid) ? bid : null,
                status: r.status,
              });
              if (r.status === 429) break;
            } catch {
              out.push({ username: uname, broadcastId: null, status: 0 });
            }
            if (i + 1 < args.usernames.length) {
              const gap =
                args.gapMin +
                Math.floor(Math.random() * (args.gapMax - args.gapMin + 1));
              await new Promise((res) => setTimeout(res, gap));
            }
          }
          return out;
        },
        {
          usernames: toProbe,
          gapMin: PROBE_GAP_MS_MIN,
          gapMax: PROBE_GAP_MS_MAX,
        },
      );
      probedThisCycle = probed.map((p) => p.username);
      for (const p of probed) {
        if (p.status === 429) rateLimited = true;
        if (p.status === 401 || p.status === 403) blocked = true;
        if (p.broadcastId) {
          pushLive(map, p.username, p.broadcastId);
          source = map.size === 1 ? "following_probe" : "mixed";
        }
      }
    }

    // Advance rotation by the window size (tray hits still count as covered).
    if (rotationBase.length) {
      const adv = advanceProbeCursor(
        rotationBase.length,
        cache.probeCursor,
        window.length || batchSize,
      );
      cache.probeCursor = adv.nextCursor;
      completedSweep = adv.completedSweep;
      if (completedSweep) {
        cache.lastFullSweepAt = new Date().toISOString();
      }
    }
    cache.lastProbeBatch = window;
    await saveFollowingCache(env, cache);

    const meta = {
      followingCount: cache.usernames.length,
      lastFullSweepAt: cache.lastFullSweepAt,
      lastFollowingRefreshAt: cache.refreshedAt,
    };

    if (!map.size && rateLimited) {
      return {
        ok: false,
        kind: "rate_limited",
        detail:
          "Instagram rate-limit (HTTP 429) — takip canlı taraması ertelendi.",
        ...meta,
      };
    }
    if (!map.size && blocked) {
      return {
        ok: false,
        kind: "blocked",
        detail: "Instagram oturumu reddedildi (401/403).",
        ...meta,
      };
    }

    const lives = [...map.values()].sort((a, b) =>
      a.username.localeCompare(b.username),
    );
    const viaProbe = lives.filter((l) => probedThisCycle.includes(l.username));
    const eta = formatSweepEtaTr(
      cache.usernames.length,
      batchSize,
      opts?.pollIntervalMs ?? 330_000,
    );
    const sweepBit = completedSweep
      ? " · tam tur tamamlandı"
      : cache.usernames.length
        ? ` · tam tur ${eta}`
        : "";
    return {
      ok: true,
      lives,
      source,
      followingCount: cache.usernames.length,
      lastFullSweepAt: cache.lastFullSweepAt,
      lastFollowingRefreshAt: cache.refreshedAt,
      probedThisCycle,
      probeCursor: cache.probeCursor,
      completedSweep,
      detail:
        lives.length === 0
          ? `Takip edilenlerde aktif canlı yok (tepsi + ${window.length} profil yoklaması; takip ${cache.usernames.length})${sweepBit}.`
          : `${lives.length} takip canlısı: ${lives.map((l) => l.username).join(", ")}` +
            (viaProbe.length
              ? ` (profil yoklama: ${viaProbe.map((l) => l.username).join(", ")})`
              : "") +
            ` · takip ${cache.usernames.length}${sweepBit}`,
    };
  } catch (err) {
    return {
      ok: false,
      kind: "error",
      detail: err instanceof Error ? err.message.slice(0, 200) : String(err),
    };
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {
        /* ignore */
      }
    }
  }
}
