import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatTry(amount: number | null | undefined): string {
  if (amount == null || !Number.isFinite(amount)) return "—";
  return `${Math.round(amount).toLocaleString("tr-TR")} TRY`;
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return "—";
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rem = s % 60;
  if (h > 0) return `${h} sa ${m} dk`;
  if (m > 0) return `${m} dk ${rem} sn`;
  return `${rem} sn`;
}

export function formatDateTr(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("tr-TR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function confidenceLabel(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `%${Math.round(v * 100)}`;
}

export const STATUS_TR: Record<string, string> = {
  uploaded: "Yüklendi",
  probing: "İnceleniyor",
  ready: "Hazır",
  extracting: "Çıkarılıyor",
  extracted: "Çıkarıldı",
  transcribing: "Transkript",
  analyzing: "Analiz",
  complete: "Tamam",
  failed: "Hata",
  awaiting_live: "Canlı bekleniyor",
  recording: "Kaydediliyor",
  candidate: "Aday",
  needs_review: "İnceleme",
  confirmed: "Onaylı",
  rejected: "Red",
  bekleniyor: "Bekleniyor",
  kaydediliyor: "Kaydediliyor",
  bitti: "Bitti",
  bulunamadi: "Bulunamadı",
  engellendi: "Engellendi",
  iptal: "İptal",
  hata: "Hata",
  yok: "Yok",
  yuklu: "Yüklü",
};

export function statusTr(s: string | null | undefined): string {
  if (!s) return "—";
  return STATUS_TR[s] ?? s;
}
