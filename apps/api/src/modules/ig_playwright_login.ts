/**
 * Playwright login for operator backup Instagram watcher account.
 * Normal browser login only — no stealth/anti-bot kits, no private API.
 * Exports Netscape cookies into storage/secrets for yt-dlp --cookies.
 */
import type { AppEnv } from "../lib/env.ts";
import {
  saveIgCookiesText,
  saveIgCredentials,
  setIgSessionLastError,
  getIgSessionStatus,
  type IgSessionPublicStatus,
} from "./ig_session.ts";

type Cookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Strict" | "Lax" | "None";
};

function cookiesToNetscape(cookies: Cookie[]): string {
  const lines = ["# Netscape HTTP Cookie File", "# mezatizle playwright export", ""];
  for (const c of cookies) {
    const domain = c.domain || "";
    if (!domain) continue;
    const flag = domain.startsWith(".") ? "TRUE" : "FALSE";
    const secure = c.secure ? "TRUE" : "FALSE";
    const expiry =
      typeof c.expires === "number" && c.expires > 0
        ? Math.floor(c.expires)
        : 0;
    lines.push(
      [
        domain,
        flag,
        c.path || "/",
        secure,
        String(expiry),
        c.name,
        c.value,
      ].join("\t"),
    );
  }
  return `${lines.join("\n")}\n`;
}

let loginInFlight = false;

export async function playwrightIgLogin(
  env: AppEnv,
  opts: { username: string; password: string; headless?: boolean },
): Promise<IgSessionPublicStatus> {
  if (loginInFlight) {
    throw new Error("Playwright girişi zaten sürüyor");
  }
  const username = opts.username.trim().replace(/^@/, "");
  const password = opts.password;
  if (!username || !password) {
    throw new Error("Kullanıcı adı ve parola gerekli");
  }

  loginInFlight = true;
  // Persist credentials encrypted (never returned); cookies become primary auth.
  await saveIgCredentials(env, username, password);

  let chromium: typeof import("playwright").chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    loginInFlight = false;
    throw new Error(
      "Playwright yüklü değil. Sunucuda: cd apps/api && bun add playwright && bunx playwright install chromium",
    );
  }

  const headless = opts.headless !== false;
  const browser = await chromium.launch({
    headless,
    args: ["--disable-dev-shm-usage", "--no-sandbox"],
  });

  try {
    const context = await browser.newContext({
      locale: "tr-TR",
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(60_000);

    await page.goto("https://www.instagram.com/accounts/login/", {
      waitUntil: "domcontentloaded",
    });

    // Cookie banner dismiss (best-effort)
    for (const label of ["Allow all cookies", "Tüm çerezlere izin ver", "Accept", "Kabul Et"]) {
      const btn = page.getByRole("button", { name: label });
      if (await btn.count().catch(() => 0)) {
        await btn.first().click({ timeout: 3000 }).catch(() => undefined);
      }
    }

    const userInput = page.locator('input[name="username"]');
    const passInput = page.locator('input[name="password"]');
    await userInput.waitFor({ state: "visible", timeout: 30_000 });
    await userInput.fill(username);
    await passInput.fill(password);
    await page.locator('button[type="submit"]').first().click();

    // Wait for either home feed, challenge, or error
    await Promise.race([
      page.waitForURL(/instagram\.com\/(accounts\/onetap|challenge|\/?$|explore)/, {
        timeout: 90_000,
      }),
      page.waitForSelector('nav', { timeout: 90_000 }),
      page.waitForSelector('[role="alert"]', { timeout: 90_000 }),
    ]).catch(() => undefined);

    await new Promise((r) => setTimeout(r, 2500));

    // Dismiss common post-login dialogs
    for (const label of [
      "Not Now",
      "Şimdi Değil",
      "Not now",
      "Save info",
      "Bilgileri kaydet",
    ]) {
      const btn = page.getByRole("button", { name: label });
      if (await btn.count().catch(() => 0)) {
        await btn.first().click({ timeout: 2000 }).catch(() => undefined);
        await new Promise((r) => setTimeout(r, 800));
      }
    }

    const url = page.url();
    if (/challenge|checkpoint|two_factor|accounts\/login/i.test(url)) {
      const msg =
        "Instagram ek doğrulama istedi (challenge/2FA). Çerezleri tarayıcıdan dışa aktarıp cookies.txt olarak yükleyin.";
      await setIgSessionLastError(env, msg);
      throw new Error(msg);
    }

    const cookies = (await context.cookies()) as Cookie[];
    const hasSession = cookies.some(
      (c) =>
        (c.name === "sessionid" || c.name === "ds_user_id") &&
        c.domain.includes("instagram"),
    );
    if (!hasSession) {
      const msg =
        "Giriş sonrası session çerezi alınamadı. Kullanıcı/parola hatalı olabilir veya Instagram engelledi.";
      await setIgSessionLastError(env, msg);
      throw new Error(msg);
    }

    const netscape = cookiesToNetscape(cookies);
    await saveIgCookiesText(env, netscape);
    await setIgSessionLastError(env, null);
    await context.close();
    return getIgSessionStatus(env);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await setIgSessionLastError(env, msg);
    throw err;
  } finally {
    await browser.close().catch(() => undefined);
    loginInFlight = false;
  }
}
