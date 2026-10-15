/** Heuristic Turkish Instagram-live auction phrases (LOCAL rules; no LLM / paid API).
 *
 * Priorities: (1) minimize cost  (2) miss few real sales  (3) never invent wrong buyer/price.
 *
 * Turkish mezat model (yesilkoy-style “aldım” lives):
 * - Seller «aldım X lira» / ask price → **listing / opening price**, NEVER a sale by itself
 * - After ask: first follower comment «aldım» (OCR, with username) → buyer at listed price
 * - Bidding: opening → OCR bids («X», «X veririm») → seller win confirm → sale
 * - Counter: buyer «18 veririm» + seller accept → sale at 18 (not ask)
 * - Spoken first name without @ → never buyer_username
 * - Prefer unknown / no sale over inventing from seller chatter
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
  /** Spoken first name after win phrase — never copied into buyer_username. */
  spokenBuyerName?: string;
  productHint?: string;
  confidence: number;
  matched: string;
  /** Why confidence was raised/lowered (debug; safe to store). */
  reason?: string;
}

export type ParseAuctionSource = "transcript" | "comment";

export type ParseAuctionOpts = {
  source?: ParseAuctionSource;
};

/** Minimum confidence to materialize a sale candidate (reconcile gate). */
export const SALE_MIN_CONFIDENCE = 0.78;

/** Window (ms) to look for nearby OCR bids when attaching a buyer to a sold event. */
export const SALE_BID_LOOKBACK_MS = 45_000;

/** Max ms after ask for first comment «aldım» to claim the lot. */
export const ALDIM_CLAIM_WINDOW_MS = 90_000;

const CORRECTION_RE =
  /(düzeltme|duzeltme|yanl[ıi][sş]|iptal(?:\s+edildi)?|geri\s*al|özür|ozur|hata\s*oldu|yanl[ıi][sş]\s*söyled|vazgeç|vazge[cç]|işlem\s*yok|islem\s*yok)/i;

const UNSOLD_RE =
  /(sat[ıi]lmad[ıi]|kal[ıi]yor(?!\s*@)|kimse\s+almad[ıi]|al[ıi]c[ıi]\s+yok|passt|\bpas\b|geçiyoruz|geciyoruz|geçtik|gectik|bir\s+sonraki|sıradaki\s+ürüne)/i;

/** Explicit seller win / sold — NOT seller «aldım» ask. */
const SOLD_RE =
  /(sat[ıi]ld[ıi]|sold(?:\s+to)?|alan(?:[ıi])?\s+bell[iı]|satt[ıi]k|kazanan\s*[:@]|gitti\s*[@]|kapatt[ıi]k|onaylad[ıi]m\s*sat|tebrikler\s*@|['']?da\s+kald[ıi]|da\s+kald[ıi]|kazand[ıi]|ald[ıi]\s+@|@\w+\s+ald[ıi])/i;

/** Seller accepts a counter-offer. */
const ACCEPT_RE =
  /\b(tamam|olur|kabul|senin\s*olsun|anla[sş]t[ıi]k|veriyorum\s*sana|al\s+o\s+zaman|oldu\s+bu|peki\s+olur|okey|okay)\b/i;

const BID_RE =
  /(ald[ıi]m|al[ıi]yorum|ben\s+ald[ıi]m|ben\s*[-:]?\s*\d+|^\s*\+?\s*\d{2,7}\s*(tl|₺|try)?\s*$|artt[ıi]r(?:d[ıi]m)?|arttir|veriyorum|veririm|\+\s*\d{2,7}|bid|benim|üstüne|ustune)/i;

const COUNTER_RE = /(\d{2,7}|[a-zçğıöşü\s]+bin)\s*veririm|\bveririm\b/i;

const INTRO_RE =
  /(s[ıi]radaki|yeni\s+ürün|yeni\s+urun|lot\s*\d+|ürünümüz|urunumüz|ba[sş]l[ıi]yoruz|a[cç][ıi]l[ıi][sş]\s*\d)/i;

const PRICE_WORD_RE =
  /(fiyat|a[cç][ıi]l[ıi][sş]|acilis|minimum|min\.?|a[cç]ılış|son\s+fiyat|a[cç][ıi]yorum)/i;

const IG_USER_RE = /@([A-Za-z0-9._]{1,30})/g;

/** OCR / ASR garbage: mostly non-letters, or tiny fragments. */
export function isAuctionNoise(text: string): boolean {
  const t = text.trim();
  if (t.length < 2) return true;
  if (t.length > 280) return true;
  const letters = (t.match(/[A-Za-zÀ-ÿĞğÜüŞşİıÖöÇç]/g) || []).length;
  const digits = (t.match(/\d/g) || []).length;
  if (letters + digits < 2) return true;
  const symbols = (t.match(/[^A-Za-zÀ-ÿĞğÜüŞşİıÖöÇç0-9\s@._+\-₺]/g) || [])
    .length;
  if (t.length >= 4 && symbols / t.length > 0.45) return true;
  return false;
}

const CURRENCY_RE =
  /(?:tl|₺|try|türk\s*liras[ıi]|turk\s*liras[ıi]|liras[ıi]?)/i;

export function hasCurrencyMarker(text: string): boolean {
  return CURRENCY_RE.test(text);
}

export function foldTrToken(raw: string): string {
  return raw
    .toLocaleLowerCase("tr-TR")
    .replace(/ı/g, "i")
    .replace(/ğ/g, "g")
    .replace(/ü/g, "u")
    .replace(/ş/g, "s")
    .replace(/ö/g, "o")
    .replace(/ç/g, "c");
}

const TR_ONES: Record<string, number> = {
  sifir: 0,
  bir: 1,
  iki: 2,
  uc: 3,
  dort: 4,
  bes: 5,
  alti: 6,
  yedi: 7,
  sekiz: 8,
  dokuz: 9,
};

const TR_TENS: Record<string, number> = {
  on: 10,
  yirmi: 20,
  otuz: 30,
  kirk: 40,
  elli: 50,
  altmis: 60,
  yetmis: 70,
  seksen: 80,
  doksan: 90,
};

export function consumeTrNumberTokens(
  tokens: string[],
  start = 0,
): { value: number; next: number } | null {
  let i = start;
  let total = 0;
  let current = 0;
  let matched = false;

  while (i < tokens.length) {
    const t = tokens[i]!;
    if (/^\d{1,7}$/.test(t)) {
      current += Number(t);
      matched = true;
      i++;
      continue;
    }
    if (t in TR_ONES) {
      current += TR_ONES[t]!;
      matched = true;
      i++;
      continue;
    }
    if (t in TR_TENS) {
      current += TR_TENS[t]!;
      matched = true;
      i++;
      continue;
    }
    if (t === "yuz") {
      current = (current || 1) * 100;
      matched = true;
      i++;
      continue;
    }
    if (t === "bin") {
      total += (current || 1) * 1000;
      current = 0;
      matched = true;
      i++;
      continue;
    }
    break;
  }

  if (!matched) return null;
  const value = total + current;
  if (!Number.isFinite(value) || value < 10 || value > 9_999_999) return null;
  return { value, next: i };
}

export function parseTurkishWordAmount(text: string): number | undefined {
  const folded = foldTrToken(text);
  const tokens = folded
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (!tokens.length) return undefined;

  const candidates: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const got = consumeTrNumberTokens(tokens, i);
    if (!got) continue;
    const span = tokens.slice(i, got.next);
    const followed = tokens[got.next] ?? "";
    const strong =
      span.includes("bin") ||
      span.includes("yuz") ||
      followed === "lira" ||
      followed === "lirasi" ||
      followed === "tl" ||
      followed === "try";
    if (strong || got.value >= 1000) candidates.push(got.value);
    if (strong) i = Math.max(i, got.next - 1);
  }
  if (!candidates.length) return undefined;
  const binScale = candidates.filter((n) => n >= 1000);
  const pool = binScale.length ? binScale : candidates;
  return Math.max(...pool);
}

function clampPriceTry(n: number | undefined): number | undefined {
  if (n == null || !Number.isFinite(n) || n < 10 || n > 9_999_999) {
    return undefined;
  }
  return Math.round(n);
}

/** Parse TRY amount: 700 TL, 1.500, on bin, 8 bin lira, üç bin beş yüz. */
export function parsePriceTry(text: string): number | undefined {
  const t = text.trim();
  const withCur = t.match(
    /(\d{1,3}(?:[.,]\d{3})+|\d{2,7})\s*(?:tl|₺|try|türk\s*liras[ıi]|turk\s*liras[ıi]|liras[ıi]?)/i,
  );
  if (withCur?.[1]) {
    const raw = withCur[1].replace(/\./g, "").replace(/,/g, "");
    return clampPriceTry(Number(raw));
  }

  const digitBin = foldTrToken(t).match(
    /(\d{1,3})\s*bin(?:\s+(\d{1,3}))?(?=\s|$|lira|tl|try|turk)/,
  );
  if (digitBin?.[1]) {
    let n = Number(digitBin[1]) * 1000;
    if (digitBin[2]) n += Number(digitBin[2]);
    return clampPriceTry(n);
  }

  const words = parseTurkishWordAmount(t);
  if (words != null) return clampPriceTry(words);

  const bare = t.match(
    /(?:^|[^\d])(\d{1,3}(?:[.,]\d{3})+|\d{2,7})(?:[^\d]|$)/,
  );
  const raw = (bare?.[1] ?? "").replace(/\./g, "").replace(/,/g, "");
  if (!raw) return undefined;
  return clampPriceTry(Number(raw));
}

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

const SPOKEN_NAME_STOP = new Set(
  [
    "tl",
    "try",
    "bin",
    "lira",
    "lirasi",
    "dostlar",
    "arkadas",
    "arkadaslar",
    "evet",
    "bu",
    "da",
    "de",
    "bir",
    "iki",
    "uc",
    "on",
    "alti",
    "bes",
    "yeni",
    "urun",
    "urunumuz",
    "aldi",
    "kaldi",
  ].map(foldTrToken),
);

/**
 * Spoken name from win phrases («Mehmet aldı», «satıldı Ayşe») — UI only.
 */
export function parseSpokenBuyerName(text: string): string | undefined {
  if (parseBuyerHint(text)) return undefined;
  const patterns = [
    /(?:sat[ıi]ld[ıi]|sold(?:\s+to)?)\s+([A-Za-zÇĞİÖŞÜçğıöşüÂâÎîÛû]{2,24})(?=\s|$|,|\d)/i,
    /([A-Za-zÇĞİÖŞÜçğıöşüÂâÎîÛû]{2,24})\s+ald[ıi](?!\s*m)\b/i,
    /([A-Za-zÇĞİÖŞÜçğıöşüÂâÎîÛû]{2,24})['']?da\s+kald[ıi]/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (!m?.[1]) continue;
    const name = m[1].trim();
    if (SPOKEN_NAME_STOP.has(foldTrToken(name))) continue;
    if (/^\d/.test(name)) continue;
    return name;
  }
  return undefined;
}

/**
 * Seller ASR «aldım on bin lira» = ASK / opening price — not a completed sale.
 * @deprecated name kept for callers; use isSellerAldimAsk.
 */
export function isSellerAldimClosing(
  text: string,
  amountTry: number | undefined,
): boolean {
  return isSellerAldimAsk(text, amountTry);
}

/** Seller listing phrase with amount (bin/lira). */
export function isSellerAldimAsk(
  text: string,
  amountTry: number | undefined,
): boolean {
  if (amountTry == null) return false;
  if (!/ald[ıi]m/i.test(text)) return false;
  if (SOLD_RE.test(text)) return false;
  const hasBin = /\bbin\b/i.test(text);
  const hasCur = hasCurrencyMarker(text);
  return hasBin || hasCur;
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
    return { confidence: 0.72, reason: "sold+price+currency_no_buyer" };
  }
  if (hasPrice) {
    return { confidence: 0.62, reason: "sold+price_no_currency" };
  }
  if (hasBuyer) {
    return { confidence: 0.7, reason: "sold+@buyer_no_price" };
  }
  return { confidence: 0.55, reason: "sold_phrase_only" };
}

export function splitAuctionClauses(text: string): string[] {
  const t = text.trim();
  if (!t) return [];
  const byPunct = t
    .split(
      /(?<=[.!?…])\s+|(?<=,)\s+(?=(?:sat[ıi]ld[ıi]|sold|yeni\s+ürün|s[ıi]radaki|ald[ıi]m))/i,
    )
    .map((s) => s.trim())
    .filter(Boolean);
  if (byPunct.length > 1) return byPunct;

  const soldSplit = t
    .split(/(?=\bsat[ıi]ld[ıi]\b|\bsold\b)/i)
    .map((s) => s.trim())
    .filter(Boolean);
  if (soldSplit.length > 1) return soldSplit;

  return [t];
}

export function parseAuctionTexts(
  text: string,
  opts?: ParseAuctionOpts,
): ParsedAuctionSignal[] {
  const out: ParsedAuctionSignal[] = [];
  for (const clause of splitAuctionClauses(text)) {
    const s = parseAuctionText(clause, opts);
    if (s) out.push(s);
  }
  return out;
}

export function parseAuctionText(
  text: string,
  opts?: ParseAuctionOpts,
): ParsedAuctionSignal | null {
  const t = text.trim();
  if (isAuctionNoise(t)) return null;

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
  const spokenBuyerName = parseSpokenBuyerName(t);
  const source = opts?.source;

  // Explicit win / sold (seller confirmation) — requires evidence later
  if (SOLD_RE.test(t)) {
    const { confidence, reason } = soldConfidence(
      Boolean(buyerHint),
      amountTry != null,
      hasCurrency || /\bbin\b/i.test(t),
    );
    return {
      eventType: "sold",
      amountTry,
      buyerHint,
      spokenBuyerName,
      confidence,
      matched: t,
      reason,
    };
  }

  // Seller accept of counter («tamam 18 bin», «olur») — bare «tamam» alone is chatter
  if (source === "transcript" && ACCEPT_RE.test(t)) {
    const bareChatter = /^(tamam|olur|okey|okay|kabul|peki)[.!?…]*$/i.test(t);
    if (bareChatter && amountTry == null && !buyerHint) {
      return null;
    }
    return {
      eventType: "sold",
      amountTry,
      buyerHint,
      spokenBuyerName,
      confidence: amountTry != null ? 0.8 : 0.55,
      matched: t,
      reason: amountTry != null ? "counter_accept+price" : "counter_accept",
    };
  }

  // Seller «aldım X lira» = ASK PRICE (listing), never sold
  if (source === "transcript" && isSellerAldimAsk(t, amountTry)) {
    return {
      eventType: "price_mention",
      amountTry,
      productHint: t.slice(0, 120),
      confidence: hasCurrency || /\bbin\b/i.test(t) ? 0.75 : 0.65,
      matched: t,
      reason: "seller_aldim_ask",
    };
  }

  // Follower / OCR bids (incl. bare «aldım», «18 veririm»)
  if (BID_RE.test(t) || COUNTER_RE.test(t)) {
    const isCounter = COUNTER_RE.test(t);
    return {
      eventType: "bid",
      amountTry,
      buyerHint,
      confidence: amountTry
        ? hasCurrency
          ? 0.72
          : 0.65
        : /ald[ıi]m/i.test(t)
          ? 0.6
          : 0.55,
      matched: t,
      reason: isCounter
        ? "counter_offer"
        : /ald[ıi]m/i.test(t)
          ? "aldim_claim"
          : "bid_phrase",
    };
  }

  if (
    buyerHint &&
    amountTry != null &&
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

  // Seller opening price without «aldım»
  if (
    source === "transcript" &&
    amountTry != null &&
    (PRICE_WORD_RE.test(t) || hasCurrency || /\bbin\b/i.test(t))
  ) {
    return {
      eventType: "price_mention",
      amountTry,
      confidence: hasCurrency ? 0.6 : 0.5,
      matched: t,
      reason: PRICE_WORD_RE.test(t) ? "price_mention" : "seller_price_line",
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
  reason?: string;
  eventId?: string;
}

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
  if (sold.amountTry != null && pick.amountTry === sold.amountTry) {
    next.confidence = Math.min(0.95, sold.confidence + 0.08);
  } else {
    next.confidence = Math.min(0.9, sold.confidence + 0.04);
  }
  return next;
}

export type TimelineEvent = {
  id: string;
  offsetMs: number;
  eventType: AuctionEventType;
  source: "transcript" | "comment";
  amountTry?: number;
  buyerHint?: string;
  spokenBuyerName?: string;
  reason?: string;
  matched: string;
  confidence: number;
  productHint?: string;
};

export type SaleMethod =
  | "aldim_first_comment"
  | "bid_win_confirm"
  | "counter_accept"
  | "sold_phrase";

export type SaleCandidate = {
  offsetMs: number;
  amountTry?: number;
  buyerUsername?: string;
  spokenBuyerName?: string;
  confidence: number;
  reason: string;
  saleMethod: SaleMethod;
  evidenceEventIds: string[];
  productHint?: string;
  askAmountTry?: number;
};

type LotWindow = {
  openMs: number;
  askAmount?: number;
  productHint?: string;
  openEventIds: string[];
  /** First OCR «aldım» claimer after ask. */
  aldimClaim?: { buyer: string; offsetMs: number; eventId: string };
  bids: BidContext[];
  closed: boolean;
};

/**
 * Product-window reconcile: seller ask ≠ sale; first comment aldım wins;
 * bid+confirm; counter+accept. Prefer no sale over inventing.
 */
export function reconcileMezatWindows(
  events: TimelineEvent[],
): SaleCandidate[] {
  const sorted = [...events].sort((a, b) => a.offsetMs - b.offsetMs);
  const sales: SaleCandidate[] = [];
  let win: LotWindow | null = null;

  const flushAldimIfClaimed = (closeMs: number) => {
    if (!win || win.closed) return;
    // Only auto-complete aldım lots when we have a real OCR buyer claim
    // and no auction bidding superseded it.
    if (
      win.aldimClaim &&
      win.askAmount != null &&
      win.bids.filter((b) => b.amountTry != null).length === 0
    ) {
      sales.push({
        offsetMs: win.aldimClaim.offsetMs,
        amountTry: win.askAmount,
        buyerUsername: win.aldimClaim.buyer,
        confidence: 0.88,
        reason: "aldim_first_comment+ask_price",
        saleMethod: "aldim_first_comment",
        evidenceEventIds: [
          ...win.openEventIds,
          win.aldimClaim.eventId,
        ],
        productHint: win.productHint,
        askAmountTry: win.askAmount,
      });
    }
    win.closed = true;
    void closeMs;
    win = null;
  };

  const openLot = (ev: TimelineEvent, ask?: number) => {
    flushAldimIfClaimed(ev.offsetMs);
    win = {
      openMs: ev.offsetMs,
      askAmount: ask ?? ev.amountTry,
      productHint: ev.productHint ?? ev.matched.slice(0, 120),
      openEventIds: [ev.id],
      bids: [],
      closed: false,
    };
  };

  for (const ev of sorted) {
    const reason = ev.reason ?? "";

    if (ev.eventType === "pass") {
      if (win && !win.closed) {
        win.closed = true;
        win = null;
      }
      continue;
    }

    if (
      ev.eventType === "price_mention" ||
      ev.eventType === "item_intro"
    ) {
      // New ask / product opens a window
      if (
        reason === "seller_aldim_ask" ||
        reason === "seller_price_line" ||
        reason === "price_mention" ||
        ev.eventType === "item_intro"
      ) {
        openLot(ev, ev.amountTry);
      } else if (win && !win.closed && ev.amountTry != null) {
        win.askAmount = ev.amountTry;
        win.openEventIds.push(ev.id);
      }
      continue;
    }

    if (ev.eventType === "bid") {
      if (!win || win.closed) {
        // Orphan bid — ignore as sale (need ask or later confirm)
        continue;
      }
      const isAldimClaim =
        reason === "aldim_claim" ||
        (/ald[ıi]m/i.test(ev.matched) && ev.amountTry == null);
      if (
        isAldimClaim &&
        ev.buyerHint &&
        !win.aldimClaim &&
        ev.offsetMs - win.openMs <= ALDIM_CLAIM_WINDOW_MS
      ) {
        win.aldimClaim = {
          buyer: ev.buyerHint,
          offsetMs: ev.offsetMs,
          eventId: ev.id,
        };
      }
      if (ev.buyerHint || ev.amountTry != null) {
        win.bids.push({
          offsetMs: ev.offsetMs,
          amountTry: ev.amountTry,
          buyerHint: ev.buyerHint,
          source: ev.source,
          reason: ev.reason,
          eventId: ev.id,
        });
      }
      continue;
    }

    if (ev.eventType === "sold") {
      // Correlate with open window
      let buyer = ev.buyerHint;
      let amount = ev.amountTry;
      let method: SaleMethod = reason.includes("counter_accept")
        ? "counter_accept"
        : "sold_phrase";
      const evidence = [ev.id];

      if (win && !win.closed) {
        evidence.push(...win.openEventIds);
        if (win.askAmount != null && amount == null) amount = win.askAmount;

        // Counter-accept: take latest counter bid amount + buyer
        if (method === "counter_accept" || reason.includes("counter_accept")) {
          const counters = win.bids.filter(
            (b) =>
              b.reason === "counter_offer" ||
              (b.amountTry != null && b.buyerHint),
          );
          const last = counters[counters.length - 1];
          if (last) {
            if (last.buyerHint) buyer = buyer ?? last.buyerHint;
            if (last.amountTry != null) amount = last.amountTry;
            if (last.eventId) evidence.push(last.eventId);
            method = "counter_accept";
          }
        }

        // Win confirm after bids
        if (!buyer && win.bids.length) {
          const enriched = enrichSoldFromBids(
            {
              eventType: "sold",
              confidence: ev.confidence,
              matched: ev.matched,
              amountTry: amount,
              buyerHint: buyer,
              reason: ev.reason,
            },
            win.bids,
            ev.offsetMs,
          );
          buyer = enriched.buyerHint;
          if (buyer) method = "bid_win_confirm";
          for (const b of win.bids) {
            if (b.eventId && b.buyerHint === buyer) evidence.push(b.eventId);
          }
        }

        // Aldım claim + seller later confirms
        if (!buyer && win.aldimClaim) {
          buyer = win.aldimClaim.buyer;
          amount = amount ?? win.askAmount;
          evidence.push(win.aldimClaim.eventId);
          method = "aldim_first_comment";
        }

        win.closed = true;
        win = null;
      }

      // Gate: need buyer comment OR @ on confirmation; price preferred
      const hasBuyer = Boolean(buyer);
      const hasPrice = amount != null;
      let confidence = ev.confidence;
      if (hasBuyer && hasPrice) confidence = Math.max(confidence, 0.88);
      else if (hasBuyer) confidence = Math.max(confidence, 0.8);
      else if (hasPrice) {
        // Seller said satıldı with price but no @ / OCR buyer → skip (prefer unknown)
        confidence = Math.min(confidence, 0.7);
      } else {
        confidence = Math.min(confidence, 0.55);
      }

      const pseudo = { eventType: "sold" as const, confidence };
      if (!isSaleWorthy(pseudo)) continue;
      // Extra precision: never materialize sale without buyer evidence
      if (!hasBuyer) continue;

      sales.push({
        offsetMs: ev.offsetMs,
        amountTry: amount,
        buyerUsername: buyer,
        spokenBuyerName: ev.spokenBuyerName,
        confidence,
        reason: `${reason || "sold"}+${method}`,
        saleMethod: method,
        evidenceEventIds: [...new Set(evidence)],
        productHint: ev.productHint ?? ev.matched.slice(0, 120),
        askAmountTry: amount,
      });
    }
  }

  // End of timeline: complete open aldım claim if any
  flushAldimIfClaimed(Number.MAX_SAFE_INTEGER);

  return sales;
}

/**
 * ASR sometimes concatenates repeated «bin beş yüz» into absurd TRY amounts
 * (e.g. 501_500, 1_002_000). Exclude those from ask-sum KPIs only.
 */
export const OFFER_AMOUNT_SANITY_MAX_TRY = 100_000;

/** KPI: product windows opened (asks) — not sales. */
export function summarizeOfferWindows(events: TimelineEvent[]): {
  productsOffered: number;
  offeredSumTry: number;
} {
  const sorted = [...events].sort((a, b) => a.offsetMs - b.offsetMs);
  let productsOffered = 0;
  let offeredSumTry = 0;
  let open = false;
  for (const ev of sorted) {
    const reason = ev.reason ?? "";
    const isAsk =
      ev.eventType === "price_mention" ||
      ev.eventType === "item_intro";
    if (!isAsk) continue;
    if (
      reason === "seller_aldim_ask" ||
      reason === "seller_price_line" ||
      reason === "price_mention" ||
      ev.eventType === "item_intro"
    ) {
      // New window
      productsOffered += 1;
      if (
        ev.amountTry != null &&
        Number.isFinite(ev.amountTry) &&
        ev.amountTry > 0 &&
        ev.amountTry <= OFFER_AMOUNT_SANITY_MAX_TRY
      ) {
        offeredSumTry += ev.amountTry;
      }
      open = true;
    } else if (open && ev.amountTry != null) {
      // price update inside window — do not double-count product
    }
  }
  return { productsOffered, offeredSumTry };
}

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
