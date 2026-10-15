/** Heuristic Turkish Instagram-live auction phrases (LOCAL rules; no LLM / paid API).
 *
 * Priorities: (1) minimize cost  (2) miss few real sales  (3) never invent wrong buyer/price.
 *
 * Semantics:
 * - Comment "aldım" / "500" / "+50" → bid (never sold)
 * - Seller "satıldı @user 700 TL" → sold (high confidence with @ + currency)
 * - Spoken first name without @ → never becomes buyer_username
 * - Corrections / iptal / satılmadı → pass (void), not sold
 * - OCR noise (garbage glyphs, lone digits) → ignored by caller via null / low conf
 */

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
  /** Why confidence was raised/lowered (debug; safe to store). */
  reason?: string;
}

/** Minimum confidence to materialize a sale candidate (reconcile gate). */
export const SALE_MIN_CONFIDENCE = 0.78;

/** Window (ms) to look for nearby OCR bids when attaching a buyer to a sold event. */
export const SALE_BID_LOOKBACK_MS = 45_000;

const CORRECTION_RE =
  /(düzeltme|duzeltme|yanl[ıi][sş]|iptal(?:\s+edildi)?|geri\s*al|özür|ozur|hata\s*oldu|yanl[ıi][sş]\s*söyled|vazgeç|vazge[cç]|işlem\s*yok|islem\s*yok)/i;

const UNSOLD_RE =
  /(sat[ıi]lmad[ıi]|kal[ıi]yor|kaldi|kald[ıi]|kimse\s+almad[ıi]|al[ıi]c[ıi]\s+yok|passt|\bpas\b|geçiyoruz|geciyoruz|geçtik|gectik|bir\s+sonraki|sıradaki\s+ürüne)/i;

/** Seller closing phrases — NOT "aldım". */
const SOLD_RE =
  /(sat[ıi]ld[ıi]|sold(?:\s+to)?|alan(?:[ıi])?\s+bell[iı]|satt[ıi]k|kazanan\s*[:@]|gitti\s*[@]|kapatt[ıi]k|onaylad[ıi]m\s*sat|tebrikler\s*@)/i;

const BID_RE =
  /(ald[ıi]m|al[ıi]yorum|ben\s+ald[ıi]m|ben\s*[-:]?\s*\d+|^\s*\+?\s*\d{2,7}\s*(tl|₺|try)?\s*$|artt[ıi]r(?:d[ıi]m)?|arttir|veriyorum|veririm|\+\s*\d{2,7}|bid|benim|üstüne|ustune)/i;

const INTRO_RE =
  /(s[ıi]radaki|yeni\s+ürün|yeni\s+urun|lot\s*\d+|ürünümüz|urunumüz|ba[sş]l[ıi]yoruz|a[cç][ıi]l[ıi][sş]\s*\d)/i;

const PRICE_WORD_RE =
  /(fiyat|a[cç][ıi]l[ıi][sş]|acilis|minimum|min\.?|a[cç]ılış|son\s+fiyat)/i;

const IG_USER_RE = /@([A-Za-z0-9._]{1,30})/g;

/** OCR / ASR garbage: mostly non-letters, or tiny fragments. */
export function isAuctionNoise(text: string): boolean {
  const t = text.trim();
  if (t.length < 2) return true;
  if (t.length > 280) return true;
  const letters = (t.match(/[A-Za-zÀ-ÿĞğÜüŞşİıÖöÇç]/g) || []).length;
  const digits = (t.match(/\d/g) || []).length;
  if (letters + digits < 2) return true;
  // High symbol ratio (OCR garbage)
  const symbols = (t.match(/[^A-Za-zÀ-ÿĞğÜüŞşİıÖöÇç0-9\s@._+\-₺]/g) || [])
    .length;
  if (t.length >= 4 && symbols / t.length > 0.45) return true;
  return false;
}

// Avoid \\b after Turkish letters — JS \\w excludes ı/ğ/ş/…
const CURRENCY_RE =
  /(?:tl|₺|try|türk\s*liras[ıi]|turk\s*liras[ıi]|liras[ıi]?)/i;

/** True when a currency marker is present (incl. Whisper "Türk lirası"). */
export function hasCurrencyMarker(text: string): boolean {
  return CURRENCY_RE.test(text);
}

/** Parse TRY amount: 700, 700 TL, 1.500, 1,500₺, 1500 try, 700 Türk lirası. */
export function parsePriceTry(text: string): number | undefined {
  const t = text.trim();
  const withCur = t.match(
    /(\d{1,3}(?:[.,]\d{3})+|\d{2,7})\s*(?:tl|₺|try|türk\s*liras[ıi]|turk\s*liras[ıi]|liras[ıi]?)/i,
  );
  const bare = t.match(
    /(?:^|[^\d])(\d{1,3}(?:[.,]\d{3})+|\d{2,7})(?:[^\d]|$)/,
  );
  const raw = (withCur?.[1] ?? bare?.[1] ?? "")
    .replace(/\./g, "")
    .replace(/,/g, "");
  if (!raw) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 10 || n > 9_999_999) return undefined;
  return n;
}

/** Buyer only from explicit @handle — never invent from spoken first names. */
export function parseBuyerHint(text: string): string | undefined {
  IG_USER_RE.lastIndex = 0;
  const m = IG_USER_RE.exec(text);
  if (!m?.[1]) return undefined;
  const u = m[1].toLowerCase();
  if (u === "instagram" || u === "meta" || u === "reel" || u === "live") {
    return undefined;
  }
  return u;
}

function soldConfidence(
  hasBuyer: boolean,
  hasPrice: boolean,
  hasCurrency: boolean,
): { confidence: number; reason: string } {
  if (hasBuyer && hasPrice && hasCurrency) {
    return { confidence: 0.92, reason: "sold+@buyer+price+currency" };
  }
  if (hasBuyer && hasPrice) {
    return { confidence: 0.85, reason: "sold+@buyer+price" };
  }
  if (hasPrice && hasCurrency) {
    return { confidence: 0.82, reason: "sold+price+currency" };
  }
  if (hasPrice) {
    return { confidence: 0.72, reason: "sold+price_no_currency" };
  }
  if (hasBuyer) {
    return { confidence: 0.7, reason: "sold+@buyer_no_price" };
  }
  return { confidence: 0.55, reason: "sold_phrase_only" };
}

/**
 * Split long ASR lines that contain multiple lots ("… satıldı A … satıldı B …").
 * Prefer clause boundaries; fall back to sold-phrase splits.
 */
export function splitAuctionClauses(text: string): string[] {
  const t = text.trim();
  if (!t) return [];
  const byPunct = t
    .split(/(?<=[.!?…])\s+|(?<=,)\s+(?=(?:sat[ıi]ld[ıi]|sold|yeni\s+ürün|s[ıi]radaki))/i)
    .map((s) => s.trim())
    .filter(Boolean);
  if (byPunct.length > 1) return byPunct;

  // Explicit multi-sold: split before each sold keyword after the first char
  const soldSplit = t.split(/(?=\bsat[ıi]ld[ıi]\b|\bsold\b)/i).map((s) => s.trim()).filter(Boolean);
  if (soldSplit.length > 1) return soldSplit;

  return [t];
}

/** Parse one or many signals from a transcript/OCR line. */
export function parseAuctionTexts(text: string): ParsedAuctionSignal[] {
  const out: ParsedAuctionSignal[] = [];
  for (const clause of splitAuctionClauses(text)) {
    const s = parseAuctionText(clause);
    if (s) out.push(s);
  }
  return out;
}

export function parseAuctionText(text: string): ParsedAuctionSignal | null {
  const t = text.trim();
  if (isAuctionNoise(t)) return null;

  // Corrections / seller void → do not emit sold from this line
  if (CORRECTION_RE.test(t)) {
    return {
      eventType: "pass",
      confidence: 0.85,
      matched: t,
      reason: "correction_or_void",
      amountTry: parsePriceTry(t),
      buyerHint: parseBuyerHint(t),
    };
  }

  // Unsold / pass before sold ("satılmadı" contains satıl…)
  if (UNSOLD_RE.test(t)) {
    return {
      eventType: "pass",
      confidence: 0.78,
      matched: t,
      reason: "unsold_or_pass",
      amountTry: parsePriceTry(t),
    };
  }

  const hasCurrency = hasCurrencyMarker(t);
  const amountTry = parsePriceTry(t);
  const buyerHint = parseBuyerHint(t);

  // Bids before sold: "aldım 500" must never become sold
  if (BID_RE.test(t) && !SOLD_RE.test(t)) {
    return {
      eventType: "bid",
      amountTry,
      buyerHint,
      confidence: amountTry ? (hasCurrency ? 0.72 : 0.65) : 0.55,
      matched: t,
      reason: "bid_phrase",
    };
  }

  // OCR comment shape: "@user 600" / "@user 600 TL" without sold/pass words → bid
  if (
    buyerHint &&
    amountTry != null &&
    !SOLD_RE.test(t) &&
    !UNSOLD_RE.test(t) &&
    !CORRECTION_RE.test(t)
  ) {
    return {
      eventType: "bid",
      amountTry,
      buyerHint,
      confidence: hasCurrency ? 0.7 : 0.62,
      matched: t,
      reason: "ocr_at_user_price",
    };
  }

  if (SOLD_RE.test(t)) {
    const { confidence, reason } = soldConfidence(
      Boolean(buyerHint),
      amountTry != null,
      hasCurrency,
    );
    return {
      eventType: "sold",
      amountTry,
      buyerHint,
      confidence,
      matched: t,
      reason,
    };
  }

  if (INTRO_RE.test(t)) {
    return {
      eventType: "item_intro",
      productHint: t.slice(0, 120),
      amountTry,
      confidence: 0.55,
      matched: t,
      reason: "item_intro",
    };
  }

  if (amountTry != null && PRICE_WORD_RE.test(t)) {
    return {
      eventType: "price_mention",
      amountTry,
      confidence: hasCurrency ? 0.55 : 0.45,
      matched: t,
      reason: "price_mention",
    };
  }

  return null;
}

/** True when a sold signal is strong enough to open a sale row. */
export function isSaleWorthy(signal: {
  eventType: string;
  confidence: number;
}): boolean {
  if (signal.eventType !== "sold") return false;
  const min = Number(process.env.SALE_MIN_CONFIDENCE ?? SALE_MIN_CONFIDENCE);
  const gate = Number.isFinite(min) ? min : SALE_MIN_CONFIDENCE;
  return signal.confidence >= gate;
}

export interface BidContext {
  offsetMs: number;
  amountTry?: number;
  buyerHint?: string;
  source: "comment" | "transcript";
}

/**
 * Attach buyer from a nearby OCR bid when sold line lacks @handle.
 * Never invent: only reuse an existing @ from a bid in the lookback window,
 * optionally matching amount when both known.
 */
export function enrichSoldFromBids(
  sold: ParsedAuctionSignal,
  bids: BidContext[],
  soldOffsetMs: number,
  lookbackMs = SALE_BID_LOOKBACK_MS,
): ParsedAuctionSignal {
  if (sold.eventType !== "sold") return sold;
  if (sold.buyerHint) return sold;
  const window = bids.filter(
    (b) =>
      b.buyerHint &&
      b.offsetMs <= soldOffsetMs &&
      soldOffsetMs - b.offsetMs <= lookbackMs,
  );
  if (!window.length) return sold;

  let pick = window[window.length - 1]!;
  if (sold.amountTry != null) {
    const amtMatch = [...window]
      .reverse()
      .find((b) => b.amountTry != null && b.amountTry === sold.amountTry);
    if (amtMatch) pick = amtMatch;
  }

  const next: ParsedAuctionSignal = {
    ...sold,
    buyerHint: pick.buyerHint,
    reason: `${sold.reason ?? "sold"}+bid_lookback`,
  };
  // Bump confidence slightly when we linked a real @ from a bid
  if (sold.amountTry != null && pick.amountTry === sold.amountTry) {
    next.confidence = Math.min(0.95, sold.confidence + 0.08);
  } else {
    next.confidence = Math.min(0.9, sold.confidence + 0.04);
  }
  return next;
}

/** Human-readable Turkish explanation for Kanıt UI / API. */
export function explainSaleTr(opts: {
  confidence: number;
  reason?: string | null;
  buyer?: string | null;
  amountCents?: number | null;
  gaps?: string[];
}): string {
  const parts: string[] = [];
  parts.push(
    `Güven: ${(opts.confidence * 100).toFixed(0)}% (${opts.reason ?? "sold"}).`,
  );
  if (opts.buyer) parts.push(`Alıcı @${opts.buyer} kaynak satırdan.`);
  else parts.push("Alıcı bilinmiyor — uydurulmadı.");
  if (opts.amountCents != null) {
    parts.push(`Tutar: ${(opts.amountCents / 100).toFixed(0)} TRY.`);
  } else {
    parts.push("Tutar bilinmiyor — uydurulmadı.");
  }
  if (opts.gaps?.length) {
    parts.push(`Eksikler: ${opts.gaps.join(", ")}.`);
  }
  parts.push("Durum varsayılan: needs_review.");
  return parts.join(" ");
}
