/**
 * Playwright login for operator backup Instagram watcher account.
 * Normal browser login only — no stealth/anti-bot kits, no private API.
 * Exports Netscape cookies into storage/secrets for yt-dlp --cookies.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
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
  const lines = [
    "# Netscape HTTP Cookie File",
    "# mezatizle playwright export",
    "",
  ];
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

async function shot(
  page: import("playwright").Page,
  env: AppEnv,
  tag: string,
): Promise<string | null> {
  try {
    const dir = join(env.storageRoot, "secrets", "ig-login-shots");
    await mkdir(dir, { recursive: true });
    const file = join(dir, `ig-login-${tag}-${Date.now()}.png`);
    await page.screenshot({ path: file, fullPage: true });
    return file;
  } catch {
    return null;
  }
}

async function dismissCookieBanners(page: import("playwright").Page) {
  for (const label of [
    "Allow all cookies",
    "Allow All Cookies",
    "Tüm çerezlere izin ver",
    "Accept all",
    "Accept All",
    "Accept",
    "Kabul Et",
    "Decline optional cookies",
    "Only allow essential cookies",
  ]) {
    const btn = page.getByRole("button", { name: new RegExp(label, "i") });
    if ((await btn.count().catch(() => 0)) > 0) {
      await btn.first().click({ timeout: 3000 }).catch(() => undefined);
      await page.waitForTimeout(500);
    }
  }
}

/** Instagram has flipped between username/password and email/pass field names. */
async function fillLoginForm(
  page: import("playwright").Page,
  username: string,
  password: string,
) {
  const userCandidates = [
    'input[name="username"]',
    'input[name="email"]',
    'input[aria-label="Phone number, username, or email"]',
    'input[aria-label="Telefon numarası, kullanıcı adı veya e-posta"]',
    'input[autocomplete="username"]',
  ];
  const passCandidates = [
    'input[name="password"]',
    'input[name="pass"]',
    'input[type="password"]',
    'input[autocomplete="current-password"]',
  ];

  let userInput = page.locator(userCandidates[0]!);
  let foundUser = false;
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline && !foundUser) {
    await dismissCookieBanners(page);
    for (const sel of userCandidates) {
      const loc = page.locator(sel).first();
      if ((await loc.count().catch(() => 0)) > 0 && (await loc.isVisible().catch(() => false))) {
        userInput = loc;
        foundUser = true;
        break;
      }
    }
    if (!foundUser) await page.waitForTimeout(500);
  }
  if (!foundUser) {
    throw new Error(
      "Instagram giriş formu bulunamadı (kullanıcı alanı yok). Sayfa challenge/çerez duvarı olabilir — ekran görüntüsüne bakın veya cookies.txt yükleyin.",
    );
  }

  let passInput = page.locator(passCandidates[0]!);
  let foundPass = false;
  for (const sel of passCandidates) {
    const loc = page.locator(sel).first();
    if ((await loc.count().catch(() => 0)) > 0 && (await loc.isVisible().catch(() => false))) {
      passInput = loc;
      foundPass = true;
      break;
    }
  }
  if (!foundPass) {
    throw new Error("Instagram parola alanı bulunamadı.");
  }

  await userInput.click({ timeout: 5000 });
  await userInput.fill("");
  await userInput.fill(username);
  await passInput.click({ timeout: 5000 });
  await passInput.fill("");
  await passInput.fill(password);

  const submit = page
    .locator('button[type="submit"]')
    .or(page.getByRole("button", { name: /log\s*in|giriş\s*yap/i }))
    .first();
  await submit.click({ timeout: 10_000 });
}

function classifyPage(url: string, bodyText: string): {
  kind: "ok" | "challenge" | "bad_password" | "unknown";
  detailTr: string;
} {
  const u = url.toLowerCase();
  const t = bodyText.toLowerCase();
  if (
    /challenge|checkpoint|two_factor|two-factor|auth_platform|accounts\/auth/.test(
      u,
    ) ||
    /güvenlik kodu|security code|confirm it's you|suspicious/.test(t)
  ) {
    return {
      kind: "challenge",
      detailTr:
        "Instagram ek doğrulama istedi (challenge / 2FA / checkpoint). Bu arayüzden otomatik geçilemez — tarayıcıda giriş yapıp cookies.txt dışa aktarın veya doğrulamayı tamamlayın.",
    };
  }
  if (
    /sorry, your password was incorrect|şifreniz yanlış|password was incorrect|kullanıcı adı geçersiz|couldn't find an account|giriş bilgileri yanlış|hesabını bul ve giriş|find your account and log in|the password you entered is incorrect/.test(
      t,
    )
  ) {
    return {
      kind: "bad_password",
      detailTr:
        "Instagram: giriş bilgileri yanlış (kullanıcı/parola reddedildi). Parolayı kontrol edin veya cookies.txt yükleyin.",
    };
  }
  if (/accounts\/login/.test(u)) {
    return {
      kind: "unknown",
      detailTr:
        "Hâlâ giriş sayfasındayız — parola hatalı, challenge veya engel olabilir. Son ekran görüntüsü kaydedildi.",
    };
  }
  return { kind: "ok", detailTr: "Giriş sonrası sayfa açıldı." };
}

export async function playwrightIgLogin(
  env: AppEnv,
  opts: { username: string; password: string; headless?: boolean },
): Promise<IgSessionPublicStatus & { screenshotPath?: string | null }> {
  if (loginInFlight) {
    throw new Error("Playwright girişi zaten sürüyor — bitmesini bekleyin.");
  }
  const username = opts.username.trim().replace(/^@/, "");
  const password = opts.password;
  if (!username || !password) {
    throw new Error("Kullanıcı adı ve parola gerekli");
  }

  loginInFlight = true;
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
  let browser: import("playwright").Browser | null = null;
  let screenshotPath: string | null = null;

  try {
    browser = await chromium.launch({
      headless,
      args: ["--disable-dev-shm-usage", "--no-sandbox"],
    });
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
      timeout: 60_000,
    });
    await page.waitForTimeout(1500);
    await dismissCookieBanners(page);

    try {
      await fillLoginForm(page, username, password);
    } catch (err) {
      screenshotPath = await shot(page, env, "form-missing");
      throw err;
    }

    await Promise.race([
      page.waitForURL(
        /instagram\.com\/(?!accounts\/login)(accounts\/onetap|challenge|checkpoint|explore|\/?$|reel|p\/)/,
        { timeout: 90_000 },
      ),
      page.waitForSelector("nav", { timeout: 90_000 }),
      page.waitForSelector('[role="alert"]', { timeout: 90_000 }),
      page.waitForTimeout(90_000),
    ]).catch(() => undefined);

    await page.waitForTimeout(2000);

    for (const label of [
      "Not Now",
      "Şimdi Değil",
      "Not now",
      "Save info",
      "Bilgileri kaydet",
      "Save Info",
    ]) {
      const btn = page.getByRole("button", { name: new RegExp(label, "i") });
      if ((await btn.count().catch(() => 0)) > 0) {
        await btn.first().click({ timeout: 2000 }).catch(() => undefined);
        await page.waitForTimeout(600);
      }
    }

    const url = page.url();
    const bodyText = await page.locator("body").innerText().catch(() => "");
    const classified = classifyPage(url, bodyText);

    if (classified.kind !== "ok") {
      screenshotPath = await shot(page, env, classified.kind);
      await setIgSessionLastError(env, classified.detailTr);
      const err = new Error(classified.detailTr) as Error & {
        screenshotPath?: string | null;
      };
      err.screenshotPath = screenshotPath;
      throw err;
    }

    const cookies = (await context.cookies()) as Cookie[];
    const hasSession = cookies.some(
      (c) =>
        (c.name === "sessionid" || c.name === "ds_user_id") &&
        c.domain.includes("instagram"),
    );
    if (!hasSession) {
      screenshotPath = await shot(page, env, "no-session");
      const msg =
        "Giriş sonrası session çerezi alınamadı. Parola hatalı olabilir veya Instagram engelledi. Ekran görüntüsü kaydedildi.";
      await setIgSessionLastError(env, msg);
      throw new Error(msg);
    }

    const netscape = cookiesToNetscape(cookies);
    await saveIgCookiesText(env, netscape);
    await setIgSessionLastError(env, null);
    await context.close();
    const status = await getIgSessionStatus(env);
    return { ...status, screenshotPath };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await setIgSessionLastError(env, msg);
    const enriched = err instanceof Error ? err : new Error(msg);
    (enriched as Error & { screenshotPath?: string | null }).screenshotPath =
      (err as { screenshotPath?: string | null })?.screenshotPath ??
      screenshotPath;
    throw enriched;
  } finally {
    await browser?.close().catch(() => undefined);
    loginInFlight = false;
  }
}
