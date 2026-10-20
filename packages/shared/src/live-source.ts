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
  /** Public page to watch / pass to yt-dlp (never a private API). */
  watchUrl: string;
  inputRaw: string;
}

const LIVE_URL_RE =
  /^https?:\/\/(www\.)?instagram\.com\/([A-Za-z0-9._]{1,30})\/live\/?/i;
const PROFILE_URL_RE =
  /^https?:\/\/(www\.)?instagram\.com\/([A-Za-z0-9._]{1,30})\/?(\?.*)?$/i;
const REEL_OR_P_RE =
  /^https?:\/\/(www\.)?instagram\.com\/(reel|p|tv)\//i;

/**
 * Parse operator input: @user, profile URL, or …/live URL.
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
      throw new Error("Yalnızca herkese açık Instagram bağlantıları kabul edilir");
    }
    if (REEL_OR_P_RE.test(url.href) && !/\/live/i.test(url.pathname)) {
      throw new Error(
        "Bu bir gönderi/reel bağlantısı. Canlı yayın URL’si (…/live) veya profil/@kullanıcı girin.",
      );
    }
    const live = url.href.match(LIVE_URL_RE);
    if (live) {
      const username = requireUsername(live[2]!);
      const bid =
        url.searchParams.get("broadcast_id") ||
        url.searchParams.get("broadcastId");
      const watchUrl =
        bid && /^\d{5,}$/.test(bid)
          ? `https://www.instagram.com/${username}/live/?broadcast_id=${bid}`
          : `https://www.instagram.com/${username}/live/`;
      return {
        kind: "live_url",
        username,
        watchUrl,
        inputRaw,
      };
    }
    const profile = url.href.match(PROFILE_URL_RE);
    if (profile) {
      const username = requireUsername(profile[2]!);
      return {
        kind: "profile_url",
        username,
        watchUrl: `https://www.instagram.com/${username}/live/`,
        inputRaw,
      };
    }
    throw new Error("Anlaşılamayan Instagram URL’si");
  }

  const username = requireUsername(inputRaw);
  return {
    kind: "username",
    username,
    watchUrl: `https://www.instagram.com/${username}/live/`,
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
