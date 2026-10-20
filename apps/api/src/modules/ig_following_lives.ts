/**
 * Discover which accounts the watcher IG follows that are currently live.
 *
 * Uses operator cookies + Playwright same-origin web calls (reels_tray /
 * homepage signals). No private API kits, no credential stuffing.
 *
 * Politeness: one browser session per poll; default interval ~5–6 min
 * (caller jitter); on HTTP 429 back off harder (caller). Prefer reels_tray
 * (single request) over probing every followed profile.
 */
import { readFile } from "node:fs/promises";
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
  source: "reels_tray" | "html_signals" | "mixed";
};

export type FollowingLivesPollFail = {
  ok: false;
  kind: "blocked" | "rate_limited" | "error" | "no_cookies";
  detail: string;
};

export type FollowingLivesPollResult =
  | FollowingLivesPollOk
  | FollowingLivesPollFail;

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
  return [...map.values()];
}

let pollInFlight: Promise<FollowingLivesPollResult> | null = null;

/**
 * Poll Instagram (watcher cookies) for followed accounts that are live.
 */
export async function pollFollowingLives(
  env: AppEnv,
): Promise<FollowingLivesPollResult> {
  if (pollInFlight) {
    try {
      return await pollInFlight;
    } catch {
      /* fall through to new poll */
    }
  }
  const run = doPollFollowingLives(env);
  pollInFlight = run.finally(() => {
    pollInFlight = null;
  });
  return run;
}

async function doPollFollowingLives(
  env: AppEnv,
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
    if (home && home.status() === 429) {
      return {
        ok: false,
        kind: "rate_limited",
        detail: "Instagram ana sayfa HTTP 429 (rate-limit).",
      };
    }
    if (/accounts\/login/i.test(page.url())) {
      return {
        ok: false,
        kind: "blocked",
        detail:
          "Çerezlerle giriş yapılamadı. Ayarlar → Instagram oturumu → cookies yenileyin.",
      };
    }
    await page.waitForTimeout(1200);

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
      const bodies: { url: string; status: number; json: unknown | null; text: string }[] =
        [];
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
          bodies.push({ url, status: r.status, json, text: text.slice(0, 50_000) });
        } catch (err) {
          bodies.push({
            url,
            status: 0,
            json: null,
            text: err instanceof Error ? err.message : String(err),
          });
        }
      }
      // Also scrape current document for live_broadcast_id pairs
      const html = document.documentElement?.innerHTML?.slice(0, 200_000) || "";
      return { bodies, html };
    });

    const map = new Map<string, FollowingLive>();
    let source: FollowingLivesPollOk["source"] = "reels_tray";
    let rateLimited = false;
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

    if (!map.size && rateLimited) {
      return {
        ok: false,
        kind: "rate_limited",
        detail:
          "Instagram rate-limit (HTTP 429) — takip canlı taraması ertelendi.",
      };
    }
    if (!map.size && blocked) {
      return {
        ok: false,
        kind: "blocked",
        detail: "Instagram oturumu reddedildi (401/403).",
      };
    }

    const lives = [...map.values()].sort((a, b) =>
      a.username.localeCompare(b.username),
    );
    return {
      ok: true,
      lives,
      source,
      detail:
        lives.length === 0
          ? "Takip edilenlerde aktif canlı yok (veya tepside görünmüyor)."
          : `${lives.length} takip canlısı: ${lives.map((l) => l.username).join(", ")}`,
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
