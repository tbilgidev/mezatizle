/**
 * Operator-provided Instagram session for live capture (backup account).
 * Prefer Netscape cookies.txt; optional username/password stored server-side only.
 * Secrets never returned to the API/frontend after save.
 */
import {
  chmod,
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve, isAbsolute } from "node:path";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { AppEnv } from "../lib/env.ts";

const SECRETS_DIR = "secrets";
const COOKIES_FILE = "ig-cookies.txt";
const CREDS_FILE = "ig-credentials.enc";
const META_FILE = "ig-session-meta.json";
const KEY_FILE = "ig-local.key";

export type IgSessionStatus = "yok" | "yuklu" | "hata";

export interface IgSessionPublicStatus {
  status: IgSessionStatus;
  hasCookies: boolean;
  hasCredentials: boolean;
  cookiesPathConfigured: boolean;
  usernameMasked: string | null;
  updatedAt: string | null;
  lastError: string | null;
  hintTr: string;
}

interface SessionMeta {
  updatedAt?: string;
  lastError?: string | null;
  usernameMasked?: string | null;
  hasCookies?: boolean;
  hasCredentials?: boolean;
  externalCookiesPath?: string | null;
}

function secretsRoot(env: AppEnv) {
  return resolve(env.storageRoot, SECRETS_DIR);
}

async function ensureSecretsDir(env: AppEnv) {
  const dir = secretsRoot(env);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    await chmod(dir, 0o700);
  } catch {
    /* ignore */
  }
  return dir;
}

async function loadMeta(env: AppEnv): Promise<SessionMeta> {
  try {
    const raw = await readFile(join(secretsRoot(env), META_FILE), "utf8");
    return JSON.parse(raw) as SessionMeta;
  } catch {
    return {};
  }
}

async function saveMeta(env: AppEnv, meta: SessionMeta) {
  const dir = await ensureSecretsDir(env);
  const path = join(dir, META_FILE);
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(meta, null, 2), { mode: 0o600 });
  await rename(tmp, path);
  try {
    await chmod(path, 0o600);
  } catch {
    /* ignore */
  }
}

async function localKey(env: AppEnv): Promise<Buffer> {
  const dir = await ensureSecretsDir(env);
  const keyPath = join(dir, KEY_FILE);
  try {
    const existing = await readFile(keyPath);
    if (existing.length >= 32) return existing.subarray(0, 32);
  } catch {
    /* create */
  }
  const fromEnv = process.env.MEZATIZLE_SECRETS_KEY?.trim();
  const key = fromEnv
    ? createHash("sha256").update(fromEnv).digest()
    : randomBytes(32);
  await writeFile(keyPath, key, { mode: 0o600 });
  try {
    await chmod(keyPath, 0o600);
  } catch {
    /* ignore */
  }
  return key;
}

function maskUsername(u: string): string {
  const s = u.trim();
  if (s.length <= 2) return "••••";
  if (s.length <= 4) return `${s[0]}••${s[s.length - 1]}`;
  return `${s.slice(0, 2)}••••${s.slice(-2)}`;
}

function looksLikeNetscapeCookies(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (t.includes("# Netscape HTTP Cookie File") || t.includes("# HTTP Cookie File")) {
    return true;
  }
  // tab-separated domain lines
  const lines = t.split(/\r?\n/).filter((l) => l && !l.startsWith("#"));
  if (!lines.length) return false;
  const sample = lines.slice(0, 5);
  return sample.every((l) => l.split("\t").length >= 6 || l.includes("instagram.com"));
}

export async function getIgSessionStatus(env: AppEnv): Promise<IgSessionPublicStatus> {
  await ensureSecretsDir(env);
  const meta = await loadMeta(env);
  const cookiesPath = join(secretsRoot(env), COOKIES_FILE);
  let hasCookies = false;
  try {
    const st = await stat(cookiesPath);
    hasCookies = st.isFile() && st.size > 0;
  } catch {
    hasCookies = false;
  }
  if (!hasCookies && meta.externalCookiesPath) {
    try {
      const st = await stat(meta.externalCookiesPath);
      hasCookies = st.isFile() && st.size > 0;
    } catch {
      hasCookies = false;
    }
  }
  let hasCredentials = false;
  try {
    const st = await stat(join(secretsRoot(env), CREDS_FILE));
    hasCredentials = st.isFile() && st.size > 0;
  } catch {
    hasCredentials = false;
  }

  const lastError = meta.lastError ?? null;
  const status: IgSessionStatus = lastError
    ? "hata"
    : hasCookies || hasCredentials
      ? "yuklu"
      : "yok";

  return {
    status,
    hasCookies,
    hasCredentials,
    cookiesPathConfigured: Boolean(meta.externalCookiesPath),
    usernameMasked: meta.usernameMasked ?? null,
    updatedAt: meta.updatedAt ?? null,
    lastError,
    hintTr:
      "Yedek Instagram hesabınızın oturumunu burada tanımlayın. Tercihen Netscape cookies.txt; isteğe bağlı kullanıcı/parola yalnızca sunucuda saklanır ve bir daha gösterilmez.",
  };
}

export async function saveIgCookiesText(
  env: AppEnv,
  cookiesText: string,
): Promise<IgSessionPublicStatus> {
  if (!looksLikeNetscapeCookies(cookiesText)) {
    throw new Error(
      "Geçersiz çerez dosyası. Netscape cookies.txt formatı bekleniyor (yt-dlp / tarayıcı dışa aktarımı).",
    );
  }
  if (cookiesText.length > 2_000_000) {
    throw new Error("Çerez dosyası çok büyük");
  }
  const dir = await ensureSecretsDir(env);
  const path = join(dir, COOKIES_FILE);
  const tmp = `${path}.tmp`;
  await writeFile(tmp, cookiesText.replace(/\r\n/g, "\n"), { mode: 0o600 });
  await rename(tmp, path);
  await chmod(path, 0o600).catch(() => undefined);

  const meta = await loadMeta(env);
  meta.hasCookies = true;
  meta.externalCookiesPath = null;
  meta.updatedAt = new Date().toISOString();
  meta.lastError = null;
  await saveMeta(env, meta);
  return getIgSessionStatus(env);
}

export async function saveIgCookiesFilePath(
  env: AppEnv,
  absOrRel: string,
): Promise<IgSessionPublicStatus> {
  const raw = absOrRel.trim();
  if (!raw) throw new Error("Çerez dosya yolu gerekli");
  if (raw.includes("\0") || raw.includes("..")) {
    throw new Error("Güvensiz dosya yolu");
  }
  const abs = isAbsolute(raw) ? resolve(raw) : resolve(process.cwd(), raw);
  const st = await stat(abs);
  if (!st.isFile()) throw new Error("Çerez dosyası bulunamadı");
  if (st.size > 2_000_000) throw new Error("Çerez dosyası çok büyük");
  const text = await readFile(abs, "utf8");
  if (!looksLikeNetscapeCookies(text)) {
    throw new Error("Belirtilen dosya Netscape cookies.txt gibi görünmüyor");
  }
  // Copy into secrets for stable yt-dlp path + perms
  await saveIgCookiesText(env, text);
  const meta = await loadMeta(env);
  meta.externalCookiesPath = abs;
  meta.updatedAt = new Date().toISOString();
  meta.lastError = null;
  await saveMeta(env, meta);
  return getIgSessionStatus(env);
}

export async function saveIgCredentials(
  env: AppEnv,
  username: string,
  password: string,
): Promise<IgSessionPublicStatus> {
  const u = username.trim().replace(/^@/, "");
  const p = password;
  if (!u || u.length > 60) throw new Error("Geçersiz kullanıcı adı");
  if (!p || p.length < 4 || p.length > 200) throw new Error("Geçersiz parola");

  const key = await localKey(env);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plain = Buffer.from(JSON.stringify({ username: u, password: p }), "utf8");
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  const payload = Buffer.concat([iv, tag, enc]).toString("base64");

  const dir = await ensureSecretsDir(env);
  const path = join(dir, CREDS_FILE);
  const tmp = `${path}.tmp`;
  await writeFile(tmp, payload, { mode: 0o600 });
  await rename(tmp, path);
  await chmod(path, 0o600).catch(() => undefined);

  const meta = await loadMeta(env);
  meta.hasCredentials = true;
  meta.usernameMasked = maskUsername(u);
  meta.updatedAt = new Date().toISOString();
  meta.lastError = null;
  await saveMeta(env, meta);
  return getIgSessionStatus(env);
}

export async function clearIgSession(env: AppEnv): Promise<IgSessionPublicStatus> {
  const dir = await ensureSecretsDir(env);
  for (const f of [COOKIES_FILE, CREDS_FILE]) {
    try {
      await unlink(join(dir, f));
    } catch {
      /* ignore */
    }
  }
  await saveMeta(env, {
    hasCookies: false,
    hasCredentials: false,
    usernameMasked: null,
    externalCookiesPath: null,
    updatedAt: new Date().toISOString(),
    lastError: null,
  });
  return getIgSessionStatus(env);
}

export async function setIgSessionLastError(env: AppEnv, err: string | null) {
  const meta = await loadMeta(env);
  meta.lastError = err;
  meta.updatedAt = meta.updatedAt ?? new Date().toISOString();
  await saveMeta(env, meta);
}

/** Absolute cookies path for yt-dlp --cookies, or null. */
export async function resolveCookiesPath(env: AppEnv): Promise<string | null> {
  const path = join(secretsRoot(env), COOKIES_FILE);
  try {
    const st = await stat(path);
    if (st.isFile() && st.size > 0) return path;
  } catch {
    /* none */
  }
  return null;
}

export async function resolveCredentials(
  env: AppEnv,
): Promise<{ username: string; password: string } | null> {
  try {
    const raw = await readFile(join(secretsRoot(env), CREDS_FILE), "utf8");
    const buf = Buffer.from(raw, "base64");
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const data = buf.subarray(28);
    const key = await localKey(env);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(data), decipher.final()]).toString(
      "utf8",
    );
    const j = JSON.parse(plain) as { username?: string; password?: string };
    if (!j.username || !j.password) return null;
    return { username: j.username, password: j.password };
  } catch {
    return null;
  }
}

/** Extra yt-dlp argv for operator session (cookies preferred). */
export async function ytDlpAuthArgs(env: AppEnv): Promise<string[]> {
  const args: string[] = [];
  const cookies = await resolveCookiesPath(env);
  if (cookies) {
    args.push("--cookies", cookies);
    return args;
  }
  const creds = await resolveCredentials(env);
  if (creds) {
    args.push("--username", creds.username, "--password", creds.password);
  }
  return args;
}
