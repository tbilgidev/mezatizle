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
