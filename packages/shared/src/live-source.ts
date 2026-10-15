export type LiveSourceKind = "live_url" | "profile_url" | "username";

function requireUsername(raw: string): string {
  const cleaned = raw.trim().replace(/^@/, "").toLowerCase();
  if (!/^[a-z0-9._]{1,30}$/.test(cleaned)) {
    throw new Error(
      "Geçersiz Instagram kullanıcı adı (1–30 karakter; harf, rakam, . _)",
    );
  }
  return cleaned;
}

export interface ParsedLiveSource {
  kind: LiveSourceKind;
  username: string;
  /** Page / identity to watch (may include broadcast_id query). */
  watchUrl: string;
  inputRaw: string;
  /** When present on input URL — preferred for Playwright live info. */
  broadcastId?: string;
}

const LIVE_URL_RE =
  /^https?:\/\/(www\.)?instagram\.com\/([A-Za-z0-9._]{1,30})\/live\/?/i;
const PROFILE_URL_RE =
  /^https?:\/\/(www\.)?instagram\.com\/([A-Za-z0-9._]{1,30})\/?(\?.*)?$/i;
const REEL_OR_P_RE =
  /^https?:\/\/(www\.)?instagram\.com\/(reel|p|tv)\//i;
/** Live sometimes shared as /reel/… with broadcast/live query — rare. */
const LIVE_REEL_HINT_RE = /[?&](broadcast_id|media_id)=/i;

function broadcastIdFromUrl(url: URL): string | undefined {
  const q =
    url.searchParams.get("broadcast_id") ||
    url.searchParams.get("broadcastId");
  if (q && /^\d{5,}$/.test(q)) return q;
  return undefined;
}

function watchUrlFor(username: string, broadcastId?: string): string {
  const base = `https://www.instagram.com/${username}/live/`;
  return broadcastId ? `${base}?broadcast_id=${broadcastId}` : base;
}

/**
 * Parse operator input: @user, profile URL, …/live URL, or live+broadcast_id.
 * Rejects private-API style hosts and non-Instagram URLs.
 */
export function parseLiveSourceInput(raw: string): ParsedLiveSource {
  const inputRaw = raw.trim();
  if (!inputRaw) throw new Error("Canlı yayın bağlantısı veya kullanıcı adı gerekli");
  if (inputRaw.length > 500) throw new Error("Girdi çok uzun");

  if (/^(https?:)?\/\//i.test(inputRaw)) {
    let url: URL;
    try {
      url = new URL(inputRaw.startsWith("//") ? `https:${inputRaw}` : inputRaw);
    } catch {
      throw new Error("Geçersiz URL");
    }
    const host = url.hostname.replace(/^www\./, "").toLowerCase();
    if (host !== "instagram.com") {
      throw new Error("Yalnızca Instagram bağlantıları kabul edilir");
    }

    const broadcastId = broadcastIdFromUrl(url);

    // Reel/post: reject unless clearly a live share with broadcast_id
    if (REEL_OR_P_RE.test(url.href) && !/\/live/i.test(url.pathname)) {
      if (broadcastId || LIVE_REEL_HINT_RE.test(url.href)) {
        // Cannot reliably map reel→username here; ask for @user or /live/
        throw new Error(
          "Reel/gönderi linki canlı kimliğini taşımıyor olabilir. @kullanıcı veya …/user/live/?broadcast_id=… girin.",
        );
      }
      throw new Error(
        "Bu bir gönderi/reel bağlantısı. Canlı yayın URL’si (…/live) veya profil/@kullanıcı girin.",
      );
    }

    const live = url.href.match(LIVE_URL_RE);
    if (live) {
      const username = requireUsername(live[2]!);
      return {
        kind: "live_url",
        username,
        watchUrl: watchUrlFor(username, broadcastId),
        inputRaw,
        broadcastId,
      };
    }
    const profile = url.href.match(PROFILE_URL_RE);
    if (profile) {
      const username = requireUsername(profile[2]!);
      return {
        kind: "profile_url",
        username,
        watchUrl: watchUrlFor(username, broadcastId),
        inputRaw,
        broadcastId,
      };
    }
    throw new Error("Anlaşılamayan Instagram URL’si");
  }

  const username = requireUsername(inputRaw);
  return {
    kind: "username",
    username,
    watchUrl: watchUrlFor(username),
    inputRaw,
  };
}

export const CAPTURE_STATUS_TR: Record<string, string> = {
  bekleniyor: "Bekleniyor",
  kaydediliyor: "Kaydediliyor",
  bitti: "Bitti",
  bulunamadi: "Yayın bulunamadı",
  engellendi: "Erişim engellendi",
  iptal: "İptal",
  hata: "Hata",
};
