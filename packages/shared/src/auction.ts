/** Heuristic Turkish auction phrase patterns (local rules; no LLM required). */
export type AuctionEventType =
  | "item_intro"
  | "bid"
  | "price_mention"
  | "sold"
  | "pass"
  | "unknown";

export interface ParsedAuctionSignal {
  eventType: AuctionEventType;
  amountTry?: number;
  buyerHint?: string;
  productHint?: string;
  confidence: number;
  matched: string;
}

// Avoid \\b — JS word boundaries break on Turkish letters (ı/ğ/ş/…).
const SOLD_RE =
  /(satıldı|satildi|sold|alan\s+bell[iı]|gitti|kazanan)/i;
const BID_RE =
  /(ben\s+ald[ıi]m|ben\s*[- ]?\s*\d+|bid|\+\s*\d+|arttır|arttir)/i;
const PRICE_RE =
  /(\d{2,7})\s*(tl|₺|try)?/i;
const INTRO_RE =
  /(sıradaki|siradaki|yeni\s+ürün|yeni\s+urun|lot\s*\d+|ürünümüz|urunumüz|başlıyoruz|basliyoruz)/i;
const PASS_RE = /(passt|\bpas\b|geçiyoruz|geciyoruz|kal[ıi]yor)/i;

export function parseAuctionText(text: string): ParsedAuctionSignal | null {
  const t = text.trim();
  if (!t) return null;

  if (SOLD_RE.test(t)) {
    const price = t.match(PRICE_RE);
    const buyer = t.match(/@([A-Za-z0-9._]{1,30})/);
    return {
      eventType: "sold",
      amountTry: price ? Number(price[1]) : undefined,
      buyerHint: buyer?.[1],
      confidence: 0.75,
      matched: t,
    };
  }
  if (BID_RE.test(t)) {
    const price = t.match(PRICE_RE);
    const buyer = t.match(/@([A-Za-z0-9._]{1,30})/);
    return {
      eventType: "bid",
      amountTry: price ? Number(price[1]) : undefined,
      buyerHint: buyer?.[1],
      confidence: 0.65,
      matched: t,
    };
  }
  if (PASS_RE.test(t)) {
    return { eventType: "pass", confidence: 0.6, matched: t };
  }
  if (INTRO_RE.test(t)) {
    return {
      eventType: "item_intro",
      productHint: t.slice(0, 120),
      confidence: 0.55,
      matched: t,
    };
  }
  if (PRICE_RE.test(t) && /\b(fiyat|açılış|acilis|minimum|min)\b/i.test(t)) {
    const price = t.match(PRICE_RE);
    return {
      eventType: "price_mention",
      amountTry: price ? Number(price[1]) : undefined,
      confidence: 0.5,
      matched: t,
    };
  }
  return null;
}
