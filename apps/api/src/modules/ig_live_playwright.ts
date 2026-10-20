/**
 * Resolve Instagram Live stream via Playwright + operator spare-account cookies.
 * yt-dlp has no Instagram Live extractor (falls to generic → often 429).
 * We warm a browser session, discover broadcast_id, then call the same-origin
 * web live info endpoint the Instagram site itself uses — no private API kits.
 */
import { access, readFile } from "node:fs/promises";
import type { AppEnv } from "../lib/env.ts";
import { resolveCookiesPath } from "./ig_session.ts";

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

export type LiveViewerPresence = {
  recordingId: string;
  broadcastId: string;
  username: string;
  cookieUsername: string | null;
  startedAt: string;
  stop: () => Promise<void>;
};

const viewerSessions = new Map<string, LiveViewerPresence>();

export function getLiveViewerPresenceHealth() {
  return {
    active: [...viewerSessions.values()].map((s) => ({
      recordingId: s.recordingId,
      broadcastId: s.broadcastId,
      seller: s.username,
      cookieUsername: s.cookieUsername,
      startedAt: s.startedAt,
    })),
  };
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
};

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

  const browser = await chromium.launch({ headless: true });
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
  let commentTimer: ReturnType<typeof setInterval> | null = null;
  let lastHeartbeatOk = false;
  let lastHeartbeatDetail = "starting";
  let lastCommentTs = 0;
  const seenCommentPks = new Set<string>();
  let commentPollCount = 0;
  let commentHitTotal = 0;
  let lastCommentPollDetail = "not_started";

  const pollCommentsOnce = async () => {
    if (stopped || !opts.onComments) return;
    commentPollCount += 1;
    try {
      const r = await page.evaluate(
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
            if (typeof j.last_comment_ts === "number") nextTs = j.last_comment_ts;
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
        { broadcastId: broadcastId!, lastCommentTs },
      );
      if (r.status !== 200) {
        lastCommentPollDetail = `http_${r.status}${r.message ? ` ${r.message.slice(0, 60)}` : ""}`;
        // Log first failure + every ~60s (12 polls @ 5s)
        if (commentPollCount === 1 || commentPollCount % 12 === 0) {
          console.warn(
            `[live-comments] ${opts.recordingId} poll#${commentPollCount} ${lastCommentPollDetail}`,
          );
        }
        return;
      }
      lastCommentTs = r.nextTs || lastCommentTs;
      const hits: LiveCommentHit[] = [];
      for (const c of r.comments) {
        const pk = c.pk != null ? String(c.pk) : null;
        if (pk && seenCommentPks.has(pk)) continue;
        if (pk) seenCommentPks.add(pk);
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
        });
      }
      lastCommentPollDetail = `ok batch=${hits.length} total=${commentHitTotal + hits.length} ts=${lastCommentTs}`;
      if (hits.length) {
        commentHitTotal += hits.length;
        await opts.onComments(hits);
      } else if (commentPollCount === 1 || commentPollCount % 24 === 0) {
        console.log(
          `[live-comments] ${opts.recordingId} poll#${commentPollCount} empty (waiting for followers)`,
        );
      }
    } catch (err) {
      lastCommentPollDetail =
        err instanceof Error ? err.message.slice(0, 120) : String(err);
      console.warn(
        `[live-comments] ${opts.recordingId}:`,
        lastCommentPollDetail,
      );
    }
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
      lastHeartbeatDetail = lastHeartbeatOk
        ? `heartbeat_ok viewers=${r.viewer_count ?? "?"} status=${r.broadcast_status ?? "?"}`
        : `heartbeat_http_${r.status}`;
    } catch (err) {
      lastHeartbeatOk = false;
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
      await pollCommentsOnce();
      commentTimer = setInterval(() => {
        void pollCommentsOnce();
      }, 5_000);
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
    stop: async () => {
      if (stopped) return;
      stopped = true;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      if (commentTimer) clearInterval(commentTimer);
      commentTimer = null;
      viewerSessions.delete(opts.recordingId);
      try {
        await browser.close();
      } catch {
        /* ignore */
      }
      console.log(
        `[live-viewer] stopped ${opts.recordingId} last=${lastHeartbeatDetail}`,
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
