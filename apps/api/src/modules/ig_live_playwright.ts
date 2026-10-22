/**
 * Resolve Instagram Live stream via Playwright + operator spare-account cookies.
 * yt-dlp has no Instagram Live extractor (falls to generic → often 429).
 * We warm a browser session, discover broadcast_id, then call the same-origin
 * web live info endpoint the Instagram site itself uses — no private API kits.
 */
import { access, readFile } from "node:fs/promises";
import type { AppEnv } from "../lib/env.ts";
import { resolveCookiesPath, setIgSessionCookieUsername } from "./ig_session.ts";
import {
  COMMENT_CATCHUP_EVERY_MS,
  COMMENT_SOFT_REFRESH_COOLDOWN_MIN,
  catchupCommentTs,
  isCommentFreeze,
  nextApiPollDelayMs,
  nextCommentBackoffMs,
  nextDomScrapeDelayMs,
  ratePolicySummaryTr,
} from "./live_comment_capture.ts";

export type LiveResolveOk = {
  ok: true;
  broadcastId: string;
  streamUrl: string;
  detail: string;
  viewerCount?: number;
  broadcastStatus?: string;
};

export type LiveResolveFail = {
  ok: false;
  kind: "blocked" | "not_found" | "rate_limited" | "error";
  detail: string;
};

export type LiveResolveResult = LiveResolveOk | LiveResolveFail;

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

export function extractBroadcastIdFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const q =
      u.searchParams.get("broadcast_id") ||
      u.searchParams.get("broadcastId");
    if (q && /^\d{5,}$/.test(q)) return q;
    const m = u.href.match(/broadcast_id=(\d{5,})/i);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

export function usernameFromWatchUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts[0] && /^[A-Za-z0-9._]{1,30}$/.test(parts[0])) {
      return parts[0].toLowerCase();
    }
  } catch {
    /* ignore */
  }
  return null;
}

type LiveInfoJson = {
  id?: string;
  broadcast_status?: string;
  broadcast_message?: string;
  dash_playback_url?: string;
  dash_abr_playback_url?: string;
  dash_live_predictive_playback_url?: string;
  viewer_count?: number;
  status?: string;
  message?: string;
};

function pickStreamUrl(info: LiveInfoJson): string | null {
  for (const key of [
    "dash_abr_playback_url",
    "dash_playback_url",
    "dash_live_predictive_playback_url",
  ] as const) {
    const v = info[key];
    if (typeof v === "string" && /^https?:\/\//i.test(v)) return v;
  }
  return null;
}

function classifyHttpFail(status: number, body: string): LiveResolveFail {
  const low = body.toLowerCase();
  if (status === 401 || status === 403 || /login_required|not.?logged/i.test(low)) {
    return {
      ok: false,
      kind: "blocked",
      detail:
        "Instagram oturumu canlı bilgiye erişemedi (giriş gerekli / çerez geçersiz). Ayarlar → Instagram oturumu → cookies.txt yenileyin.",
    };
  }
  if (status === 429 || /too many requests|rate.?limit/i.test(low)) {
    return {
      ok: false,
      kind: "rate_limited",
      detail:
        "Instagram rate-limit (HTTP 429). Biraz bekleyip yeniden denenecek; sık probe yt-dlp/generic istekleri 429 üretir.",
    };
  }
  if (status === 404 || /no longer available|not found|ended/i.test(low)) {
    return {
      ok: false,
      kind: "not_found",
      detail: "Bu yayın sona ermiş veya artık erişilemiyor (404).",
    };
  }
  return {
    ok: false,
    kind: "error",
    detail: `Canlı bilgi isteği başarısız (HTTP ${status}).`,
  };
}

let resolveInFlight: Promise<LiveResolveResult> | null = null;

/**
 * Resolve an active live DASH URL using spare-account cookies in Playwright.
 */
export async function resolveLiveStreamWithPlaywright(
  env: AppEnv,
  opts: { watchUrl: string; username?: string; broadcastId?: string | null },
): Promise<LiveResolveResult> {
  // Serialize — Instagram rate-limits parallel headless sessions hard
  if (resolveInFlight) {
    try {
      await resolveInFlight;
    } catch {
      /* ignore */
    }
  }
  const run = doResolve(env, opts);
  resolveInFlight = run.finally(() => {
    resolveInFlight = null;
  });
  return run;
}

async function doResolve(
  env: AppEnv,
  opts: { watchUrl: string; username?: string; broadcastId?: string | null },
): Promise<LiveResolveResult> {
  const cookiesFile = await resolveCookiesPath(env);
  if (!cookiesFile) {
    return {
      ok: false,
      kind: "blocked",
      detail:
        "Instagram çerezi yok — canlı yayın çoğu zaman oturum ister. Ayarlar → Instagram oturumu (yedek hesap).",
    };
  }

  let cookieText: string;
  try {
    cookieText = await readFile(cookiesFile, "utf8");
  } catch {
    return {
      ok: false,
      kind: "blocked",
      detail: "Çerez dosyası okunamadı.",
    };
  }
  const cookies = parseNetscapeCookies(cookieText);
  if (!cookies.some((c) => c.name === "sessionid")) {
    return {
      ok: false,
      kind: "blocked",
      detail: "cookies.txt içinde sessionid yok — geçerli Instagram oturumu gerekli.",
    };
  }

  const username =
    opts.username ||
    usernameFromWatchUrl(opts.watchUrl) ||
    "";
  if (!username) {
    return {
      ok: false,
      kind: "error",
      detail: "Kullanıcı adı çözülemedi.",
    };
  }

  let broadcastId =
    opts.broadcastId || extractBroadcastIdFromUrl(opts.watchUrl);

  let chromium: typeof import("playwright").chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    return {
      ok: false,
      kind: "error",
      detail:
        "Playwright yüklü değil. apps/api: bun add playwright && bunx playwright install chromium",
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

    const foundIds = new Set<string>();
    if (broadcastId) foundIds.add(broadcastId);

    page.on("response", async (res) => {
      if (!/graphql/i.test(res.url())) return;
      try {
        const t = await res.text();
        // Prefer the target username's live_broadcast_id when present
        const userBlock = new RegExp(
          `"username"\\s*:\\s*"${username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[\\s\\S]{0,400}?"live_broadcast_id"\\s*:\\s*"(\\d{5,})"`,
          "i",
        );
        const mUser = t.match(userBlock);
        if (mUser?.[1]) foundIds.add(mUser[1]);
        for (const m of t.matchAll(
          /"live_broadcast_id"\s*:\s*"(\d{5,})"/g,
        )) {
          // Only keep if near a non-null visibility or matching user — still collect all then prefer
          if (m[1]) foundIds.add(m[1]);
        }
      } catch {
        /* ignore */
      }
    });

    const home = await page.goto("https://www.instagram.com/", {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });
    if (home && home.status() === 429) {
      return {
        ok: false,
        kind: "rate_limited",
        detail: "Instagram ana sayfa HTTP 429 (rate-limit).",
      };
    }
    // Confirm session
    const urlAfter = page.url();
    if (/accounts\/login/i.test(urlAfter)) {
      return {
        ok: false,
        kind: "blocked",
        detail:
          "Çerezlerle giriş yapılamadı (login sayfasına düşüldü). cookies.txt yenileyin.",
      };
    }
    await page.waitForTimeout(1200);

    const profile = await page.goto(
      `https://www.instagram.com/${username}/`,
      { waitUntil: "domcontentloaded", timeout: 45_000 },
    );
    if (profile && profile.status() === 429) {
      return {
        ok: false,
        kind: "rate_limited",
        detail: `Profil HTTP 429 (@${username}).`,
      };
    }
    if (profile && (profile.status() === 404 || /Page Not Found/i.test(await page.title()))) {
      return {
        ok: false,
        kind: "not_found",
        detail: `@${username} profili bulunamadı.`,
      };
    }
    await page.waitForTimeout(3500);

    // Prefer broadcast id discovered next to this username
    if (!broadcastId) {
      const fromPage = await page.evaluate((user) => {
        const html = document.documentElement.innerHTML;
        const re = new RegExp(
          `"username"\\s*:\\s*"${user.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[\\s\\S]{0,500}?"live_broadcast_id"\\s*:\\s*"(\\d{5,})"`,
          "i",
        );
        const m = html.match(re);
        if (m?.[1]) return m[1];
        const any = html.match(/"live_broadcast_id"\s*:\s*"(\d{5,})"/);
        return any?.[1] ?? null;
      }, username);
      if (fromPage) foundIds.add(fromPage);
      broadcastId = fromPage || [...foundIds][0] || null;
    }

    if (!broadcastId) {
      // Last resort: open /live/ (often 429 from scrapers; still try once)
      const liveNav = await page.goto(
        `https://www.instagram.com/${username}/live/`,
        { waitUntil: "domcontentloaded", timeout: 30_000 },
      ).catch(() => null);
      if (liveNav?.status() === 429) {
        return {
          ok: false,
          kind: "rate_limited",
          detail:
            "Aktif yayın kimliği bulunamadı ve /live/ sayfası HTTP 429. broadcast_id’li URL deneyin veya sonra tekrar.",
        };
      }
      await page.waitForTimeout(2000);
      const bid = extractBroadcastIdFromUrl(page.url());
      if (bid) broadcastId = bid;
    }

    if (!broadcastId) {
      return {
        ok: false,
        kind: "not_found",
        detail: `@${username} şu an canlıda görünmüyor (live_broadcast_id yok).`,
      };
    }

    const info = await page.evaluate(
      async ({ broadcastId, username }) => {
        const csrf =
          document.cookie
            .split(";")
            .map((s) => s.trim())
            .find((s) => s.startsWith("csrftoken="))
            ?.split("=")[1] || "";
        const r = await fetch(
          `https://www.instagram.com/api/v1/live/${broadcastId}/info/`,
          {
            credentials: "include",
            headers: {
              "X-IG-App-ID": "936619743392459",
              "X-Requested-With": "XMLHttpRequest",
              "X-CSRFToken": csrf,
              Referer: `https://www.instagram.com/${username}/`,
              Accept: "*/*",
            },
          },
        );
        const text = await r.text();
        let json: LiveInfoJson = {};
        try {
          json = JSON.parse(text) as LiveInfoJson;
        } catch {
          json = { message: text.slice(0, 200) };
        }
        return { status: r.status, json, raw: text.slice(0, 300) };
      },
      { broadcastId, username },
    );

    if (info.status !== 200) {
      return classifyHttpFail(info.status, info.raw || "");
    }

    const status = String(info.json.broadcast_status || "").toLowerCase();
    if (status && status !== "active" && status !== "interrupted") {
      return {
        ok: false,
        kind: "not_found",
        detail: `Yayın aktif değil (durum: ${info.json.broadcast_status}).`,
      };
    }

    const streamUrl = pickStreamUrl(info.json);
    if (!streamUrl) {
      return {
        ok: false,
        kind: "blocked",
        detail:
          "Canlı bilgi alındı ama akış URL’si yok (özel/gizli yayın veya oturum yetersiz olabilir).",
      };
    }

    const viewers =
      typeof info.json.viewer_count === "number"
        ? info.json.viewer_count
        : undefined;
    return {
      ok: true,
      broadcastId,
      streamUrl,
      viewerCount: viewers,
      broadcastStatus: info.json.broadcast_status,
      detail: `playwright_live_ok bid=${broadcastId}${viewers != null ? ` viewers=${viewers}` : ""}`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/429|Too Many Requests/i.test(msg)) {
      return {
        ok: false,
        kind: "rate_limited",
        detail: "Playwright canlı çözümlemede rate-limit.",
      };
    }
    return {
      ok: false,
      kind: "error",
      detail: `Playwright canlı çözümleme hatası: ${msg.slice(0, 200)}`,
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

/** Optional: ensure chromium binary exists (best-effort). */
export async function playwrightChromiumReady(): Promise<boolean> {
  try {
    const { chromium } = await import("playwright");
    const exe = chromium.executablePath();
    await access(exe);
    return true;
  } catch {
    return false;
  }
}

/**
 * Who is logged in via operator cookies? (no secrets returned).
 */
export async function whoamiIgCookies(
  env: AppEnv,
): Promise<{ ok: true; username: string } | { ok: false; detail: string }> {
  const cookiesFile = await resolveCookiesPath(env);
  if (!cookiesFile) return { ok: false, detail: "Çerez dosyası yok" };
  let cookieText: string;
  try {
    cookieText = await readFile(cookiesFile, "utf8");
  } catch {
    return { ok: false, detail: "Çerez okunamadı" };
  }
  const cookies = parseNetscapeCookies(cookieText);
  if (!cookies.some((c) => c.name === "sessionid")) {
    return { ok: false, detail: "sessionid yok" };
  }
  let chromium: typeof import("playwright").chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    return { ok: false, detail: "Playwright yok" };
  }
  let browser: import("playwright").Browser | null = null;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      locale: "tr-TR",
    });
    await context.addCookies(
      cookies.map((c) => ({ ...c, sameSite: "Lax" as const })),
    );
    const page = await context.newPage();
    await page.goto("https://www.instagram.com/", {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });
    await page.waitForTimeout(1500);
    const username = await page.evaluate(async () => {
      const csrf =
        document.cookie
          .split(";")
          .map((s) => s.trim())
          .find((s) => s.startsWith("csrftoken="))
          ?.split("=")[1] || "";
      const r = await fetch(
        "https://www.instagram.com/api/v1/accounts/edit/web_form_data/",
        {
          credentials: "include",
          headers: {
            "X-IG-App-ID": "936619743392459",
            "X-Requested-With": "XMLHttpRequest",
            "X-CSRFToken": csrf,
            Accept: "*/*",
          },
        },
      );
      const j = (await r.json()) as { form_data?: { username?: string } };
      return j?.form_data?.username ?? null;
    });
    if (!username) return { ok: false, detail: "Kullanıcı adı alınamadı" };
    await setIgSessionCookieUsername(env, username);
    return { ok: true, username };
  } catch (err) {
    return {
      ok: false,
      detail: err instanceof Error ? err.message.slice(0, 160) : String(err),
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

export type LiveViewerPresenceHealth = {
  lastHeartbeatOk: boolean;
  lastHeartbeatDetail: string;
  lastHeartbeatAt: number;
  lastCommentPollAt: number;
  lastCommentPollDetail: string;
  commentHitTotal: number;
  commentPollCount: number;
  /** Wall clock of last newly-accepted comment (API or DOM). */
  lastCommentHitAt: number;
  domScrapeCount: number;
  apiBackoffUntil: number;
  softRefreshCount: number;
  /**
   * True when IG heartbeat says the broadcast is no longer active
   * (or returns 400/404). Capture supervisor should finalize promptly.
   */
  broadcastEnded: boolean;
  broadcastStatus: string | null;
};

/** IG live heartbeat statuses that mean "still on air". */
const LIVE_ACTIVE_STATUSES = new Set([
  "active",
  "running",
  "started",
  "connecting",
  "joined",
  "live",
]);

export function isBroadcastStatusEnded(
  status: string | null | undefined,
): boolean {
  if (!status) return false;
  const s = status.trim().toLowerCase();
  if (!s) return false;
  if (LIVE_ACTIVE_STATUSES.has(s)) return false;
  // Known ended tokens only — unknown strings fall through to stale-bytes watchdog.
  return /stop|end|interrupt|finish|post_?live|unavailable|deleted|not.?live|offline/.test(
    s,
  );
}

export type LiveViewerPresence = {
  recordingId: string;
  broadcastId: string;
  username: string;
  cookieUsername: string | null;
  startedAt: string;
  getHealth: () => LiveViewerPresenceHealth;
  stop: () => Promise<void>;
};

const viewerSessions = new Map<string, LiveViewerPresence>();

export function getLiveViewerPresenceHealth() {
  return {
    active: [...viewerSessions.values()].map((s) => {
      const h = s.getHealth();
      return {
        recordingId: s.recordingId,
        broadcastId: s.broadcastId,
        seller: s.username,
        cookieUsername: s.cookieUsername,
        startedAt: s.startedAt,
        commentHitTotal: h.commentHitTotal,
        commentPollCount: h.commentPollCount,
        lastCommentHitAt: h.lastCommentHitAt,
        lastCommentPollDetail: h.lastCommentPollDetail,
        lastHeartbeatOk: h.lastHeartbeatOk,
        softRefreshCount: h.softRefreshCount,
      };
    }),
  };
}

export function getLiveViewerSession(
  recordingId: string,
): LiveViewerPresence | undefined {
  return viewerSessions.get(recordingId);
}

/**
 * Healthy = session exists, heartbeat recent OR last ok, and comment poll
 * (when enabled) has ticked within ~60s without a hard browser-closed failure.
 */
export function isLiveViewerPresenceHealthy(
  recordingId: string,
  opts?: { requireComments?: boolean },
): boolean {
  const s = viewerSessions.get(recordingId);
  if (!s) return false;
  const h = s.getHealth();
  const now = Date.now();
  const hbFresh = now - h.lastHeartbeatAt < 45_000;
  if (!hbFresh && !h.lastHeartbeatOk) return false;
  if (opts?.requireComments !== false) {
    if (h.commentPollCount < 1) return false;
    if (now - h.lastCommentPollAt > 60_000) return false;
    if (/Target page|browser has been closed|launch/i.test(h.lastCommentPollDetail)) {
      return false;
    }
  }
  return true;
}

/**
 * Keep a normal Playwright browser session "watching" the live for the
 * duration of recording so Instagram can count the spare account as a viewer.
 *
 * Why this is needed: resolveLiveStreamWithPlaywright only scrapes a DASH URL
 * then closes the browser; ffmpeg reads the CDN alone and never joins the live UI.
 * Instagram viewer lists come from live heartbeat / open live page sessions.
 *
 * Method: cookies → open IG → try /live/ page → periodic POST
 * /api/v1/live/{id}/heartbeat_and_get_viewer_count/ (works even when /live/ is 429).
 * No anti-bot kits.
 */
export type LiveCommentHit = {
  username: string | null;
  text: string;
  createdAtMs: number | null;
  pk: string | null;
  /** Capture channel — used for persist source + diagnostics. */
  channel?: "live_api" | "live_dom";
};

/**
 * Start or keep the Playwright viewer+comment poll for a recording.
 * CRITICAL: do NOT tear down a healthy session on every supervisor tick —
 * that was killing get_comment polls (Yeşilköy 8dcb0555 class: 0 comments).
 */
export async function ensureLiveViewerPresence(
  env: AppEnv,
  opts: {
    recordingId: string;
    watchUrl: string;
    username?: string;
    broadcastId?: string | null;
    onComments?: (hits: LiveCommentHit[]) => void | Promise<void>;
  },
): Promise<
  | { ok: true; presence: LiveViewerPresence; reused: boolean }
  | { ok: false; detail: string }
> {
  if (isLiveViewerPresenceHealthy(opts.recordingId, { requireComments: true })) {
    return {
      ok: true,
      presence: viewerSessions.get(opts.recordingId)!,
      reused: true,
    };
  }
  if (viewerSessions.has(opts.recordingId)) {
    const h = viewerSessions.get(opts.recordingId)!.getHealth();
    console.warn(
      `[live-viewer] restart unhealthy ${opts.recordingId} polls=${h.commentPollCount} hits=${h.commentHitTotal} detail=${h.lastCommentPollDetail}`,
    );
  }
  const started = await startLiveViewerPresence(env, opts);
  if (!started.ok) return started;
  return { ok: true, presence: started.presence, reused: false };
}

export async function startLiveViewerPresence(
  env: AppEnv,
  opts: {
    recordingId: string;
    watchUrl: string;
    username?: string;
    broadcastId?: string | null;
    /** Persist follower comments while live (DASH video has no comment UI). */
    onComments?: (hits: LiveCommentHit[]) => void | Promise<void>;
  },
): Promise<
  | { ok: true; presence: LiveViewerPresence }
  | { ok: false; detail: string }
> {
  await stopLiveViewerPresence(opts.recordingId);

  const cookiesFile = await resolveCookiesPath(env);
  if (!cookiesFile) {
    return { ok: false, detail: "Çerez yok — izleyici oturumu açılamadı" };
  }
  let cookieText: string;
  try {
    cookieText = await readFile(cookiesFile, "utf8");
  } catch {
    return { ok: false, detail: "Çerez okunamadı" };
  }
  const cookies = parseNetscapeCookies(cookieText);
  if (!cookies.some((c) => c.name === "sessionid")) {
    return { ok: false, detail: "sessionid yok" };
  }

  const username =
    opts.username || usernameFromWatchUrl(opts.watchUrl) || "";
  let broadcastId =
    opts.broadcastId || extractBroadcastIdFromUrl(opts.watchUrl);
  if (!username || !broadcastId) {
    // Resolve once to learn broadcast id
    const resolved = await resolveLiveStreamWithPlaywright(env, {
      watchUrl: opts.watchUrl,
      username: username || undefined,
      broadcastId,
    });
    if (!resolved.ok) {
      return {
        ok: false,
        detail: `İzleyici oturumu için yayın çözülemedi: ${resolved.detail}`,
      };
    }
    broadcastId = resolved.broadcastId;
  }
  if (!username || !broadcastId) {
    return { ok: false, detail: "username/broadcastId eksik" };
  }

  let chromium: typeof import("playwright").chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    return { ok: false, detail: "Playwright yüklü değil" };
  }

  let browser: Awaited<ReturnType<typeof chromium.launch>>;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message.slice(0, 160) : String(err);
    console.error(
      `[live-viewer] ${opts.recordingId} chromium.launch failed: ${msg}`,
    );
    return { ok: false, detail: `Playwright launch: ${msg}` };
  }
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

  let cookieUsername: string | null = null;
  let stopped = false;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let commentTimer: ReturnType<typeof setTimeout> | null = null;
  let domTimer: ReturnType<typeof setTimeout> | null = null;
  let lastHeartbeatOk = false;
  let lastHeartbeatDetail = "starting";
  let lastHeartbeatAt = Date.now();
  let lastCommentTs = 0;
  const seenCommentPks = new Set<string>();
  const seenFingerprints = new Set<string>();
  let commentPollCount = 0;
  let commentHitTotal = 0;
  let domScrapeCount = 0;
  let softRefreshCount = 0;
  let lastSoftRefreshAt = 0;
  let lastCatchupAt = 0;
  let lastCommentPollDetail = "not_started";
  let lastCommentPollAt = 0;
  let lastCommentHitAt = Date.now();
  let apiBackoffUntil = 0;
  let apiBackoffMs = 0;
  let pendingCatchup = false;
  let pageActionChain: Promise<void> = Promise.resolve();
  const sessionStartedAt = Date.now();
  let broadcastEnded = false;
  let broadcastStatus: string | null = null;
  let endedStreak = 0;

  /** Serialize Playwright page actions — single viewer, never pile up. */
  const withPageLock = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = pageActionChain.then(fn, fn);
    pageActionChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const acceptHits = async (hits: LiveCommentHit[]) => {
    if (!hits.length || !opts.onComments) return 0;
    const fresh: LiveCommentHit[] = [];
    for (const h of hits) {
      if (h.pk) {
        if (seenCommentPks.has(h.pk)) continue;
        seenCommentPks.add(h.pk);
      } else {
        const fp = `${(h.username ?? "").toLowerCase()}|${h.text.trim().toLowerCase()}|${
          h.createdAtMs != null ? Math.floor(h.createdAtMs / 5000) : "na"
        }`;
        if (seenFingerprints.has(fp)) continue;
        seenFingerprints.add(fp);
      }
      fresh.push(h);
    }
    if (!fresh.length) return 0;
    commentHitTotal += fresh.length;
    lastCommentHitAt = Date.now();
    await opts.onComments(fresh);
    return fresh.length;
  };

  const softRefreshViewer = async (why: string) => {
    if (stopped) return;
    const cooldownMs = COMMENT_SOFT_REFRESH_COOLDOWN_MIN * 60_000;
    if (Date.now() - lastSoftRefreshAt < cooldownMs) return;
    lastSoftRefreshAt = Date.now();
    softRefreshCount += 1;
    console.warn(
      `[live-comments] ${opts.recordingId} soft-refresh #${softRefreshCount}: ${why} (ffmpeg untouched)`,
    );
    await withPageLock(async () => {
      const liveUrl = `https://www.instagram.com/${username}/live/?broadcast_id=${broadcastId}`;
      try {
        const nav = await page.goto(liveUrl, {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });
        if (nav && nav.status() === 429) {
          apiBackoffMs = nextCommentBackoffMs(apiBackoffMs);
          apiBackoffUntil = Date.now() + apiBackoffMs;
          lastCommentPollDetail = `soft_refresh_429 backoff=${apiBackoffMs}`;
          await page
            .goto("https://www.instagram.com/", {
              waitUntil: "domcontentloaded",
              timeout: 30_000,
            })
            .catch(() => undefined);
          return;
        }
        await page.waitForTimeout(1500);
      } catch (err) {
        lastCommentPollDetail = `soft_refresh_err ${
          err instanceof Error ? err.message.slice(0, 80) : String(err)
        }`;
      }
      // Rewind cursor so next API poll re-walks a recent window
      const nowSec = Math.floor(Date.now() / 1000);
      lastCommentTs = catchupCommentTs(lastCommentTs, nowSec);
      lastCatchupAt = Date.now();
    });
  };

  const pollCommentsOnce = async (mode: "normal" | "catchup" = "normal") => {
    if (stopped || !opts.onComments) return;
    if (Date.now() < apiBackoffUntil) {
      lastCommentPollAt = Date.now();
      lastCommentPollDetail = `backoff_until=${apiBackoffUntil}`;
      return;
    }
    commentPollCount += 1;
    lastCommentPollAt = Date.now();
    let pollTs = lastCommentTs;
    if (mode === "catchup") {
      pollTs = catchupCommentTs(lastCommentTs, Math.floor(Date.now() / 1000));
      lastCatchupAt = Date.now();
    }
    try {
      const r = await withPageLock(() =>
        page.evaluate(
          async ({ broadcastId, lastCommentTs }) => {
            const csrf =
              document.cookie
                .split(";")
                .map((s) => s.trim())
                .find((s) => s.startsWith("csrftoken="))
                ?.split("=")[1] || "";
            const url =
              `https://www.instagram.com/api/v1/live/${broadcastId}/get_comment/` +
              `?last_comment_ts=${lastCommentTs || 0}`;
            const res = await fetch(url, {
              credentials: "include",
              headers: {
                "X-IG-App-ID": "936619743392459",
                "X-Requested-With": "XMLHttpRequest",
                "X-CSRFToken": csrf,
                Accept: "*/*",
              },
            });
            const text = await res.text();
            let comments: Array<{
              pk?: string | number;
              user?: { username?: string };
              text?: string;
              created_at?: number;
              created_time?: number;
            }> = [];
            let nextTs = lastCommentTs;
            let message = "";
            try {
              const j = JSON.parse(text) as {
                comments?: typeof comments;
                last_comment_ts?: number;
                message?: string;
              };
              comments = Array.isArray(j.comments) ? j.comments : [];
              if (typeof j.last_comment_ts === "number")
                nextTs = j.last_comment_ts;
              message = String(j.message || "");
            } catch {
              message = "non_json";
            }
            return {
              status: res.status,
              comments,
              nextTs,
              message,
              raw: text.slice(0, 120),
            };
          },
          { broadcastId: broadcastId!, lastCommentTs: pollTs },
        ),
      );
      if (r.status === 429 || /challenge|checkpoint|rate.?limit/i.test(r.message)) {
        apiBackoffMs = nextCommentBackoffMs(apiBackoffMs);
        apiBackoffUntil = Date.now() + apiBackoffMs;
        lastCommentPollDetail = `http_${r.status} backoff=${apiBackoffMs}ms ${r.message.slice(0, 40)}`;
        console.warn(
          `[live-comments] ${opts.recordingId} rate-limit → backoff ${apiBackoffMs}ms`,
        );
        return;
      }
      if (r.status !== 200) {
        lastCommentPollDetail = `http_${r.status}${r.message ? ` ${r.message.slice(0, 60)}` : ""}`;
        if (commentPollCount === 1 || commentPollCount % 12 === 0) {
          console.warn(
            `[live-comments] ${opts.recordingId} poll#${commentPollCount} ${lastCommentPollDetail}`,
          );
        }
        return;
      }
      // Success clears backoff ladder
      apiBackoffMs = 0;
      apiBackoffUntil = 0;
      // Advance cursor to the max of prior / response (catch-up must not regress forever)
      lastCommentTs = Math.max(lastCommentTs, r.nextTs || 0, pollTs);
      const hits: LiveCommentHit[] = [];
      for (const c of r.comments) {
        const pk = c.pk != null ? String(c.pk) : null;
        const text = String(c.text ?? "").trim();
        if (text.length < 1) continue;
        const username =
          typeof c.user?.username === "string"
            ? c.user.username.toLowerCase()
            : null;
        hits.push({
          username,
          text,
          createdAtMs:
            typeof c.created_at === "number"
              ? c.created_at * 1000
              : typeof c.created_time === "number"
                ? c.created_time * 1000
                : null,
          pk,
          channel: "live_api",
        });
      }
      const n = await acceptHits(hits);
      lastCommentPollDetail = `ok mode=${mode} batch=${n}/${hits.length} total=${commentHitTotal} ts=${lastCommentTs}`;
      if (!n && (commentPollCount === 1 || commentPollCount % 24 === 0)) {
        console.log(
          `[live-comments] ${opts.recordingId} poll#${commentPollCount} empty (waiting for followers)`,
        );
      }

      // Freeze while live → soft refresh (no new browser, ffmpeg untouched)
      if (
        lastHeartbeatOk &&
        !broadcastEnded &&
        isCommentFreeze(lastCommentHitAt, Date.now(), {
          sessionStartedAt,
        })
      ) {
        await softRefreshViewer("freeze_0_new_while_live");
        pendingCatchup = true;
      } else if (
        Date.now() - lastCatchupAt >= COMMENT_CATCHUP_EVERY_MS &&
        lastHeartbeatOk
      ) {
        // Periodic recent-window re-walk on next tick (dedupe absorbs overlaps)
        pendingCatchup = true;
      }
    } catch (err) {
      lastCommentPollDetail =
        err instanceof Error ? err.message.slice(0, 120) : String(err);
      console.warn(
        `[live-comments] ${opts.recordingId}:`,
        lastCommentPollDetail,
      );
      if (/Target page|browser has been closed/i.test(lastCommentPollDetail)) {
        // Mark unhealthy so ensureLiveViewerPresence can restart later
        lastCommentPollAt = Date.now() - 120_000;
      }
    }
  };

  /** Secondary channel: scrape visible live comment list from the viewer DOM. */
  const scrapeDomCommentsOnce = async () => {
    if (stopped || !opts.onComments) return;
    if (Date.now() < apiBackoffUntil) return;
    domScrapeCount += 1;
    try {
      const rows = await withPageLock(() =>
        page.evaluate(() => {
          const out: Array<{ username: string | null; text: string }> = [];
          const skip = new Set([
            "reel",
            "p",
            "stories",
            "explore",
            "direct",
            "accounts",
            "about",
            "legal",
            "privacy",
            "live",
          ]);
          const push = (username: string | null, text: string) => {
            const t = text.trim().replace(/\s+/g, " ");
            if (t.length < 1 || t.length > 500) return;
            if (username && skip.has(username)) return;
            // Drop chrome chrome / CTA noise
            if (/^(follow|takip|like|beğen|share|paylaş)$/i.test(t)) return;
            out.push({ username, text: t });
          };
          // Profile links near comment text (live chat list)
          for (const a of Array.from(
            document.querySelectorAll('a[href^="/"]'),
          ).slice(0, 80)) {
            const href = a.getAttribute("href") || "";
            const m = href.match(/^\/([A-Za-z0-9._]{2,30})\/?$/);
            if (!m) continue;
            const username = m[1].toLowerCase();
            if (skip.has(username)) continue;
            const root =
              a.closest('[role="listitem"], li, div') || a.parentElement;
            if (!root) continue;
            const raw = (root.textContent || "").replace(/\s+/g, " ").trim();
            if (!raw) continue;
            // Strip leading @username from blob
            const stripped = raw
              .replace(new RegExp(`^@?${username}\\s*`, "i"), "")
              .trim();
            if (stripped.length < 1) continue;
            push(username, stripped.slice(0, 400));
          }
          // Dedupe within this scrape
          const seen = new Set<string>();
          return out.filter((r) => {
            const k = `${r.username}|${r.text}`;
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
          }).slice(0, 40);
        }),
      );
      const hits: LiveCommentHit[] = rows.map((r) => ({
        username: r.username,
        text: r.text,
        createdAtMs: Date.now(),
        pk: null,
        channel: "live_dom" as const,
      }));
      const n = await acceptHits(hits);
      if (n > 0) {
        console.log(
          `[live-comments] ${opts.recordingId} dom +${n} (scrape#${domScrapeCount})`,
        );
      }
    } catch (err) {
      if (domScrapeCount === 1 || domScrapeCount % 10 === 0) {
        console.warn(
          `[live-comments] ${opts.recordingId} dom scrape:`,
          err instanceof Error ? err.message.slice(0, 100) : err,
        );
      }
    }
  };

  const scheduleApiPoll = () => {
    if (stopped || !opts.onComments) return;
    const delay = nextApiPollDelayMs({
      rateLimited: Date.now() < apiBackoffUntil,
      backoffMs: Math.max(0, apiBackoffUntil - Date.now()),
    });
    commentTimer = setTimeout(() => {
      const mode = pendingCatchup ? "catchup" : "normal";
      pendingCatchup = false;
      void pollCommentsOnce(mode).finally(() => scheduleApiPoll());
    }, delay);
  };

  const scheduleDomScrape = () => {
    if (stopped || !opts.onComments) return;
    const delay = nextDomScrapeDelayMs();
    domTimer = setTimeout(() => {
      void scrapeDomCommentsOnce().finally(() => scheduleDomScrape());
    }, delay);
  };

  const heartbeatOnce = async () => {
    if (stopped) return;
    try {
      const r = await page.evaluate(
        async ({ broadcastId, username }) => {
          const csrf =
            document.cookie
              .split(";")
              .map((s) => s.trim())
              .find((s) => s.startsWith("csrftoken="))
              ?.split("=")[1] || "";
          const res = await fetch(
            `https://www.instagram.com/api/v1/live/${broadcastId}/heartbeat_and_get_viewer_count/`,
            {
              method: "POST",
              credentials: "include",
              headers: {
                "X-IG-App-ID": "936619743392459",
                "X-Requested-With": "XMLHttpRequest",
                "X-CSRFToken": csrf,
                "Content-Type": "application/x-www-form-urlencoded",
                Referer: `https://www.instagram.com/${username}/live/`,
                Accept: "*/*",
              },
              body: "",
            },
          );
          const text = await res.text();
          let viewer_count: number | null = null;
          let broadcast_status: string | null = null;
          try {
            const j = JSON.parse(text) as {
              viewer_count?: number;
              broadcast_status?: string;
            };
            viewer_count =
              typeof j.viewer_count === "number" ? j.viewer_count : null;
            broadcast_status = j.broadcast_status ?? null;
          } catch {
            /* ignore */
          }
          return {
            status: res.status,
            viewer_count,
            broadcast_status,
          };
        },
        { broadcastId: broadcastId!, username },
      );
      lastHeartbeatOk = r.status === 200;
      lastHeartbeatAt = Date.now();
      broadcastStatus = r.broadcast_status ?? null;
      lastHeartbeatDetail = lastHeartbeatOk
        ? `heartbeat_ok viewers=${r.viewer_count ?? "?"} status=${r.broadcast_status ?? "?"}`
        : `heartbeat_http_${r.status}`;

      // End-of-live: HTTP 400/404 (media gone) OR explicit non-active status.
      // Require 2 consecutive signals to avoid one flaky heartbeat killing a long mezat.
      const httpGone = r.status === 400 || r.status === 404;
      const statusGone = isBroadcastStatusEnded(r.broadcast_status);
      if (httpGone || statusGone) {
        endedStreak += 1;
        if (endedStreak >= 2 && !broadcastEnded) {
          broadcastEnded = true;
          console.warn(
            `[live-viewer] ${opts.recordingId} broadcast ended (http=${r.status} status=${r.broadcast_status ?? "?"} streak=${endedStreak})`,
          );
        }
      } else if (r.status === 200) {
        endedStreak = 0;
      }
    } catch (err) {
      lastHeartbeatOk = false;
      lastHeartbeatAt = Date.now();
      lastHeartbeatDetail =
        err instanceof Error ? err.message.slice(0, 120) : String(err);
    }
  };

  try {
    await page.goto("https://www.instagram.com/", {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });
    await page.waitForTimeout(1200);
    cookieUsername = await page
      .evaluate(async () => {
        const csrf =
          document.cookie
            .split(";")
            .map((s) => s.trim())
            .find((s) => s.startsWith("csrftoken="))
            ?.split("=")[1] || "";
        const r = await fetch(
          "https://www.instagram.com/api/v1/accounts/edit/web_form_data/",
          {
            credentials: "include",
            headers: {
              "X-IG-App-ID": "936619743392459",
              "X-Requested-With": "XMLHttpRequest",
              "X-CSRFToken": csrf,
              Accept: "*/*",
            },
          },
        );
        const j = (await r.json()) as { form_data?: { username?: string } };
        return j?.form_data?.username ?? null;
      })
      .catch(() => null);

    // Best-effort open live UI (often 429 from datacenter IPs — heartbeat still works)
    const liveUrl = `https://www.instagram.com/${username}/live/?broadcast_id=${broadcastId}`;
    try {
      const nav = await page.goto(liveUrl, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      if (nav && nav.status() === 429) {
        // Stay on home — heartbeats still register the session
        await page.goto("https://www.instagram.com/", {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });
      } else {
        await page.waitForTimeout(2000);
      }
    } catch {
      await page
        .goto("https://www.instagram.com/", {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        })
        .catch(() => undefined);
    }

    await heartbeatOnce();
    heartbeatTimer = setInterval(() => {
      void heartbeatOnce();
    }, 12_000);
    if (opts.onComments) {
      console.log(
        `[live-comments] ${opts.recordingId} policy: ${ratePolicySummaryTr()}`,
      );
      await pollCommentsOnce("normal");
      scheduleApiPoll();
      // DOM secondary starts after a short settle so we don't pile onto first nav
      domTimer = setTimeout(() => {
        void scrapeDomCommentsOnce().finally(() => scheduleDomScrape());
      }, nextDomScrapeDelayMs());
    }
  } catch (err) {
    try {
      await browser.close();
    } catch {
      /* ignore */
    }
    return {
      ok: false,
      detail: `İzleyici oturumu açılamadı: ${
        err instanceof Error ? err.message.slice(0, 160) : String(err)
      }`,
    };
  }

  const presence: LiveViewerPresence = {
    recordingId: opts.recordingId,
    broadcastId,
    username,
    cookieUsername,
    startedAt: new Date().toISOString(),
    getHealth: () => ({
      lastHeartbeatOk,
      lastHeartbeatDetail,
      lastHeartbeatAt,
      lastCommentPollAt,
      lastCommentPollDetail,
      commentHitTotal,
      commentPollCount,
      lastCommentHitAt,
      domScrapeCount,
      apiBackoffUntil,
      softRefreshCount,
      broadcastEnded,
      broadcastStatus,
    }),
    stop: async () => {
      if (stopped) return;
      stopped = true;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      if (commentTimer) clearTimeout(commentTimer);
      commentTimer = null;
      if (domTimer) clearTimeout(domTimer);
      domTimer = null;
      viewerSessions.delete(opts.recordingId);
      try {
        await browser.close();
      } catch {
        /* ignore */
      }
      console.log(
        `[live-viewer] stopped ${opts.recordingId} last=${lastHeartbeatDetail} comments=${commentHitTotal} softRefresh=${softRefreshCount} dom=${domScrapeCount}`,
      );
    },
  };

  viewerSessions.set(opts.recordingId, presence);
  console.log(
    `[live-viewer] started ${opts.recordingId} as=${cookieUsername ?? "?"} watching=@${username} bid=${broadcastId} ${lastHeartbeatDetail}`,
  );
  return { ok: true, presence };
}

export async function stopLiveViewerPresence(
  recordingId: string,
): Promise<void> {
  const s = viewerSessions.get(recordingId);
  if (s) await s.stop();
}

export type FetchLiveCommentsResult = {
  ok: boolean;
  httpStatus: number;
  hits: LiveCommentHit[];
  lastCommentTs: number;
  detail: string;
  /** Raw snippet for debugging (never secrets). */
  rawSnippet?: string;
};

/**
 * One-shot comment fetch via logged-in Playwright cookies (same endpoint the
 * live viewer polls). Works while broadcast is active; ended lives usually
 * return HTTP 400/404 ("media has been deleted") — callers must treat that
 * as "backfill unavailable", not invent comments.
 */
export async function fetchLiveCommentsForBroadcast(
  env: AppEnv,
  opts: {
    broadcastId: string;
    lastCommentTs?: number;
    /** Optional: open seller live URL first (same-origin referer). */
    username?: string | null;
  },
): Promise<FetchLiveCommentsResult> {
  const cookiesFile = await resolveCookiesPath(env);
  if (!cookiesFile) {
    return {
      ok: false,
      httpStatus: 0,
      hits: [],
      lastCommentTs: opts.lastCommentTs ?? 0,
      detail: "Çerez yok",
    };
  }
  let cookieText: string;
  try {
    cookieText = await readFile(cookiesFile, "utf8");
  } catch {
    return {
      ok: false,
      httpStatus: 0,
      hits: [],
      lastCommentTs: opts.lastCommentTs ?? 0,
      detail: "Çerez okunamadı",
    };
  }
  const cookies = parseNetscapeCookies(cookieText);
  if (!cookies.some((c) => c.name === "sessionid")) {
    return {
      ok: false,
      httpStatus: 0,
      hits: [],
      lastCommentTs: opts.lastCommentTs ?? 0,
      detail: "sessionid yok",
    };
  }

  let chromium: typeof import("playwright").chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    return {
      ok: false,
      httpStatus: 0,
      hits: [],
      lastCommentTs: opts.lastCommentTs ?? 0,
      detail: "Playwright yüklü değil",
    };
  }

  const browser = await chromium.launch({ headless: true });
  try {
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
    // Warm session on home (same as viewer presence) — profile-first can look logged-out.
    await page.goto("https://www.instagram.com/", {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });
    await page.waitForTimeout(1200);
    const sessionUser = await page
      .evaluate(async () => {
        const csrf =
          document.cookie
            .split(";")
            .map((s) => s.trim())
            .find((s) => s.startsWith("csrftoken="))
            ?.split("=")[1] || "";
        const r = await fetch(
          "https://www.instagram.com/api/v1/accounts/edit/web_form_data/",
          {
            credentials: "include",
            headers: {
              "X-IG-App-ID": "936619743392459",
              "X-Requested-With": "XMLHttpRequest",
              "X-CSRFToken": csrf,
              Accept: "*/*",
            },
          },
        );
        if (!r.ok) return null;
        const j = (await r.json()) as { form_data?: { username?: string } };
        return j?.form_data?.username ?? null;
      })
      .catch(() => null);
    if (!sessionUser) {
      return {
        ok: false,
        httpStatus: 401,
        hits: [],
        lastCommentTs: opts.lastCommentTs ?? 0,
        detail: "session_invalid_or_expired — refresh Ayarlar → Instagram oturumu",
      };
    }

    // Try the same web endpoints the live UI uses (no private reverse-eng kits).
    const paths = [
      `https://www.instagram.com/api/v1/live/${opts.broadcastId}/get_comment/?last_comment_ts=${opts.lastCommentTs ?? 0}`,
      // Some builds expose a "final" comment dump after end — often 404; harmless probe.
      `https://www.instagram.com/api/v1/live/${opts.broadcastId}/get_final_comment/`,
    ];

    let best: FetchLiveCommentsResult = {
      ok: false,
      httpStatus: 0,
      hits: [],
      lastCommentTs: opts.lastCommentTs ?? 0,
      detail: "no_response",
    };

    for (const url of paths) {
      const r = await page.evaluate(async (fetchUrl) => {
        const csrf =
          document.cookie
            .split(";")
            .map((s) => s.trim())
            .find((s) => s.startsWith("csrftoken="))
            ?.split("=")[1] || "";
        const res = await fetch(fetchUrl, {
          credentials: "include",
          headers: {
            "X-IG-App-ID": "936619743392459",
            "X-Requested-With": "XMLHttpRequest",
            "X-CSRFToken": csrf,
            Accept: "*/*",
          },
        });
        const text = await res.text();
        return { status: res.status, text: text.slice(0, 4000) };
      }, url);

      let comments: Array<{
        pk?: string | number;
        user?: { username?: string };
        text?: string;
        created_at?: number;
        created_time?: number;
      }> = [];
      let nextTs = opts.lastCommentTs ?? 0;
      let message = "";
      try {
        const j = JSON.parse(r.text) as {
          comments?: typeof comments;
          last_comment_ts?: number;
          message?: string;
          status?: string;
        };
        comments = Array.isArray(j.comments) ? j.comments : [];
        if (typeof j.last_comment_ts === "number") nextTs = j.last_comment_ts;
        message = String(j.message || j.status || "");
      } catch {
        message = "non_json";
      }

      const hits: LiveCommentHit[] = [];
      for (const c of comments) {
        const text = String(c.text ?? "").trim();
        if (!text) continue;
        hits.push({
          username:
            typeof c.user?.username === "string"
              ? c.user.username.toLowerCase()
              : null,
          text,
          createdAtMs:
            typeof c.created_at === "number"
              ? c.created_at * 1000
              : typeof c.created_time === "number"
                ? c.created_time * 1000
                : null,
          pk: c.pk != null ? String(c.pk) : null,
        });
      }

      const looksHtml = /^\s*</.test(r.text) || /not-logged-in/i.test(r.text);
      best = {
        ok: r.status === 200 && !looksHtml,
        httpStatus: r.status,
        hits,
        lastCommentTs: nextTs,
        detail:
          r.status === 200 && !looksHtml
            ? `ok comments=${hits.length}`
            : looksHtml
              ? `http_${r.status} broadcast_unavailable_or_ended (HTML shell; comments not replayable)`
              : `http_${r.status}${message ? ` ${message.slice(0, 80)}` : ""}`,
        rawSnippet: r.text.slice(0, 200),
      };
      if (hits.length > 0) break;
      // Continue to next path only when empty / error
    }

    return best;
  } catch (err) {
    return {
      ok: false,
      httpStatus: 0,
      hits: [],
      lastCommentTs: opts.lastCommentTs ?? 0,
      detail: err instanceof Error ? err.message.slice(0, 160) : String(err),
    };
  } finally {
    try {
      await browser.close();
    } catch {
      /* ignore */
    }
  }
}
