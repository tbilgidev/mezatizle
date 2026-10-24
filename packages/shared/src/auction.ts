/** Heuristic Turkish Instagram-live auction phrases (LOCAL rules; no LLM / paid API).
 *
 * Priorities: (1) minimize cost  (2) miss few real sales  (3) never invent wrong buyer/price.
 *
 * Turkish mezat model (yesilkoy-style “aldım” lives):
 * - Seller «aldım X lira» / ask price → **listing / opening price**, NEVER a sale by itself
 * - After ask: first follower comment «aldım» (OCR, with username) → buyer at listed price
 * - Bidding: opening → OCR bids («X», «X veririm») → seller win confirm → sale
 * - Pey escalate: early «32 aldım» (bin shorthand) can be outbid; highest bid before
 *   seller end-marker wins (not the first claimer)
 * - Seller flower emoji (çiçek: 🌸/💐/…) as a comment closes that lot
 * - Counter: buyer «18 veririm» + seller accept → sale at 18 (not ask)
 * - Verbal win (ASR): «X hanım sizindir» / «Y bey sizde» / «hayırlı olsun Z» —
 *   match spoken name to recent aldım/bid username; seller need not reply in comments
 * - Repeated verbal confirms on the same lot → **one** sale (dedup)
 * - Spoken first name without @ → never buyer_username (unless matched to a commenter)
 * - Never attribute a sale to the seller account or sibling/brand handles (same root)
 * - Prefer unknown / no sale over inventing from seller chatter / phantom asks
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
  /** Nunus-style tray index («1 numara …»). */
  lotNumber?: number;
  /** Packing quantity («4 tane …») — reconcile may emit one sale per unit. */
  quantity?: number;
  /** Descriptor tokens for later «mavi aldım» / «kolye ucu aldım» matching. */
  descriptorTokens?: string[];
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

/**
 * Max ms after ask for first comment «aldım» to claim the lot.
 * Real mezats often claim minutes after the ask (chat lag / camera pan).
 * 90s was too tight (afra: 19 live_api aldım → 1 sale). Lot close (next ask /
 * pass / sold) remains the primary gate; this is a safety cap only.
 */
export const ALDIM_CLAIM_WINDOW_MS = 20 * 60_000;

/** Comment «aldım» may land a few seconds before the spoken ask is segmented. */
export const ALDIM_PRE_ASK_MS = 20_000;

/** After a correction/void pass, re-attach the discarded aldım to the restated ask. */
export const ALDIM_CARRY_AFTER_CORRECTION_MS = 90_000;

const CORRECTION_RE =
  /(düzeltme|duzeltme|yanl[ıi][sş]|iptal(?:\s+edildi)?|geri\s*al|özür|ozur|hata\s*oldu|yanl[ıi][sş]\s*söyled|vazgeç|vazge[cç]|işlem\s*yok|islem\s*yok)/i;

const UNSOLD_RE =
  /(sat[ıi]lmad[ıi]|kal[ıi]yor(?!\s*@)|kimse\s+almad[ıi]|al[ıi]c[ıi]\s+yok|\bpasst\b|\bpass\b|geçiyoruz|geciyoruz|geçtik|gectik|bir\s+sonraki|sıradaki\s+ürüne)/i;

/**
 * Explicit seller win / sold — NOT seller «aldım» ask.
 * `\bsold\b` (not bare `sold`) — Turkish «soldan» / «şimdi soldan» must NOT match.
 */
const SOLD_RE =
  /(sat[ıi]ld[ıi]|\bsold(?:\s+to)?\b|alan(?:[ıi])?\s+bell[iı]|satt[ıi]k|kazanan\s*[:@]|gitti\s*[@]|kapatt[ıi]k|onaylad[ıi]m\s*sat|tebrikler\s*@|['']da\s+kald[ıi]|(?<![a-zçğıöşüA-ZÇĞİÖŞÜ])(?!(?:ara|bura|ora|sura|şura)da\b)[A-Za-zÇĞİÖŞÜçğıöşü]{2,24}['']?da\s+kald[ıi]|kazand[ıi]|ald[ıi]\s+@|@\w+\s+ald[ıi])/i;

/** «Arada kaldım» / «burada kaldı» chatter — NOT a sold-to-name phrase. */
const ARADA_KALDIM_RE =
  /\b(?:ara|bura|ora|sura|şura)da\s+kald[ıi]m?\b/i;

/** Honorific after a spoken first name in verbal win phrases. */
const HONORIFIC =
  "han[ıi]m(?:c[ıi][gğ]?[ıi]m)?|bey|abla(?:c[ıi][gğ]?[ıi]m)?|abi";

/**
 * Seller verbal win confirm (ASR) — often no written reply in comments.
 * Bare «sizin» / mid-sentence «sizde» chatter is NOT a win.
 */
/** Word-ish end: ASCII `\b` breaks on Turkish ı/ğ/ü/ş/ö/ç. */
const TR_END = "(?=\\s|$|[.!?…,;:])";
const VERBAL_WIN_SIZINDIR_RE = new RegExp(
  `\\bsizin\\s*dir${TR_END}|\\bsizindir${TR_END}`,
  "i",
);
const VERBAL_WIN_SIZDE_KALDI_RE = new RegExp(
  `\\bsizde\\s+kald[ıi]${TR_END}|\\bsizde\\s+kal(?:s[ıi]n)?${TR_END}`,
  "i",
);
const VERBAL_WIN_NAME_SIZDE_RE = new RegExp(
  `\\b([A-Za-zÇĞİÖŞÜçğıöşüÂâÎîÛû]{2,24})\\s+(?:${HONORIFIC})\\s+sizde\\b`,
  "i",
);
const VERBAL_WIN_NAME_ONLY_SIZDE_RE =
  /^([A-Za-zÇĞİÖŞÜçğıöşüÂâÎîÛû]{2,24})\s+sizde[.!?…]*$/i;
const VERBAL_WIN_HAYIRLI_RE = /hay[ıi]rl[ıi](?:\s+u[gğ]urlu)?\s+olsun/i;
const VERBAL_WIN_BRAVO_RE =
  /\bbravo\s+([A-Za-zÇĞİÖŞÜçğıöşüÂâÎîÛû]{2,24})\b/i;
const VERBAL_WIN_GULE_RE =
  /g[uü]le\s+g[uü]le\s+(?:iyi\s+g[uü]nlerde\s+)?(?:kullan|tak[ıi]n?|giy)/i;

/**
 * Seller announces a named follower aldım arrived
 * («Şehnaz hanımdan bir aldım geldi», «Şeyhna … aldım geldi»).
 */
/** Leading edge: JS `\\b` breaks on Turkish capitals (Ş/İ are non-\\w). */
const TR_NAME_LEAD = "(?:^|[^A-Za-zÇĞİÖŞÜçğıöşüÂâÎîÛû])";
const TR_NAME = "([A-Za-zÇĞİÖŞÜçğıöşüÂâÎîÛû]{2,24})";
const VERBAL_WIN_ALDIM_GELDI_RE = new RegExp(
  `${TR_NAME_LEAD}${TR_NAME}(?:\\s+(?:${HONORIFIC}))?(?:\\s+\\S+){0,5}?\\s+(?:bir\\s+)?ald[ıi]m\\s+geldi`,
  "i",
);

/**
 * «Çiğdem Hanım siz bunu aldınız / aldın» — seller confirms the follower’s claim.
 * Must not use the bare «X aldı» pattern (matches «bunu aldı»).
 */
const VERBAL_WIN_SIZ_BUNU_ALDI_RE = new RegExp(
  `${TR_NAME_LEAD}${TR_NAME}\\s+(?:${HONORIFIC})\\s+siz\\s+(?:bunu|bunları|onu)\\s+ald[ıi](?:n[ıi]z|n)?\\b`,
  "i",
);

/** «ikisi de sizin olacak» / «sizin olacak» packing confirm. */
const VERBAL_WIN_SIZIN_OLACAK_RE =
  /\b(?:[iıİI]kisi\s+de\s+)?sizin\s+olacak\b/i;

/** Soft confirm without a spoken name — only closes a lot that already has an aldım/bid. */
const VERBAL_WIN_BARE_RE =
  /^(?:tamam[,.]?\s+)?(?:hay[ıi]rl[ıi](?:\s+u[gğ]urlu)?\s+olsun(?:\s+can[ıi]m)?|g[uü]le\s+g[uü]le\s+(?:iyi\s+g[uü]nlerde\s+)?(?:kullan|tak[ıi]n?|giy)(?:\s+\S+){0,6}|[iıİI]kisi\s+de\s+sizin\s+olacak|[iıİI]kisi\s+de\s+tamam|sizin\s+olacak|(?:bu\s+da\s+|o\s+da\s+)?sizde)[.!?…]*$/i;

/** Seller «İkisi de 700» / «İkisi de tamam» — dual packing confirm.
 * Leading İ must be explicit — JS `/i` does not fold Turkish İ→i. */
const VERBAL_WIN_IKISI_DE_RE =
  /(?:^|[^A-Za-zÇĞİÖŞÜçğıöşü])[iıİI]kisi\s+de\s+(?:tamam|olur|okey|okay|\d{2,7})\b/i;

/**
 * Nunus packing: «Bu Deniz hanımda», «Banu hanımda 800», «Bano hanımda 1500».
 * Locative hanımda/beyde — not «sizde».
 */
const VERBAL_WIN_HANIMDA_RE = new RegExp(
  `${TR_NAME_LEAD}${TR_NAME}\\s+(?:${HONORIFIC})da${TR_END}`,
  "i",
);

/** «Tamam sizde Cihayranımcım» / «Bu da sizde.» / bare «Sizde.» */
const VERBAL_WIN_SOFT_SIZDE_RE =
  /^(?:tamam[,.]?\s+)?(?:bu\s+da\s+|o\s+da\s+)?sizde(?:\s+[A-Za-zÇĞİÖŞÜçğıöşüÂâÎîÛû]{2,24}(?:\s+(?:han[ıi]m(?:c[ıi][gğ]?[ıi]m)?|bey))?)?[.!…]*$/i;

/** Product sold chatter «Kolye gitti» — only with an open claimed lot. */
const VERBAL_WIN_PRODUCT_GITTI_RE =
  /\b(?:kolye|kolyo|k[uü]pe|bro[sş]|bilezik|bileklik|y[uü]z[uü]k|set|u[cç])\s+gitti\b/i;

/** Foreign currency chatter must not open a TRY lot. */
const FOREIGN_CURRENCY_RE =
  /\b(?:pound|sterlin|euro|eur|dolar|dollar|usd|gbp)\w*/i;

/** Market-range chatter («18-20 bin liradan başlıyor») — not this lot's ask. */
const PRICE_RANGE_BIN_RE = /\d{1,3}\s*[-–—]\s*\d{1,3}\s*bin/i;

/**
 * Seller accepts a counter-offer.
 * Bare «olur» mid-sentence («lazım olur», «yine olur») is chatter — not accept.
 */
const ACCEPT_STRONG_RE =
  /(senin\s*olsun|anla[sş]t[ıi]k|veriyorum\s*sana|al\s+o\s+zaman|oldu\s+bu|peki\s+olur)/i;
/** Lead accept only when the rest is empty / price / soft confirm — not «Tamam için». */
const ACCEPT_LEAD_RE =
  /^(tamam|olur|okey|okay|kabul)(?:[.!?…]*|\s+(?:olur|okey|okay|kabul|peki|edir|dir|\d|[a-zçğıöşü]*\s*bin).*|$)/i;

/**
 * True «aldım» token — must NOT match inside «kaldım» / «kaldim» (geç kaldım chatter).
 * ASCII `\b` breaks on Turkish letters, so use letter lookarounds.
 */
export const ALDIM_WORD_RE =
  /(?<![A-Za-zÇĞİÖŞÜçğıöşüÂâÎîÛû])ald[ıi]m(?![A-Za-zÇĞİÖŞÜçğıöşüÂâÎîÛû])/i;

/** «Geç kaldım» / late-to-live chatter is never a take-it claim. */
const GEC_KALDIM_RE = /\bge[cç]\s+kald[ıi]m\b/i;

/**
 * Seller end-of-lot marker: flower / bouquet emoji comment (optionally with
 * hearts/prayer). Bare 🌸 closes the open pey or claimed lot.
 */
const FLOWER_EMOJI_RE = /[🌸🌺🌹🌻🌼💐🌷💮🏵🥀]/u;

const BID_RE =
  /((?<![A-Za-zÇĞİÖŞÜçğıöşüÂâÎîÛû])ald[ıi]m(?![A-Za-zÇĞİÖŞÜçğıöşüÂâÎîÛû])|al[ıi]yorum|ben\s+ald[ıi]m|ben\s*[-:]?\s*\d+|^\s*\+?\s*\d{2,7}\s*(tl|₺|try)?\s*$|artt[ıi]r(?:d[ıi]m)?|arttir|veriyorum|veririm|\+\s*\d{2,7}|bid|benim|üstüne|ustune)/i;

/** Co-host / seller comment posting the ask («Aldım 50.000₺ dir», «Aldım diyene 11 bin»). */
const COMMENT_SELLER_ASK_RE =
  /ald[ıi]m(?:\s+diyene)?[\s\S]{0,40}?\d[\s\S]{0,24}?(?:dir|dır|dur|dür)\b/i;
const ALDIM_DIYENE_ASK_RE =
  /(?:ilk\s+)?ald[ıi]m\s+diyene/i;
const ACILISIMIZ_RE =
  /a[cç][ıi]l[ıi][sş]ımız|a[cç][ıi]l[ıi][sş]ım\b/i;

const COUNTER_RE = /(\d{2,7}|[a-zçğıöşü\s]+bin)\s*veririm|\bveririm\b/i;

const INTRO_RE =
  /(s[ıi]radaki|yeni\s+ürün|yeni\s+urun|lot\s*\d+|ürünümüz|urunumüz|ba[sş]l[ıi]yoruz|a[cç][ıi]l[ıi][sş]\s*\d)/i;

const PRICE_WORD_RE =
  /(fiyat|a[cç][ıi]l[ıi][sş]|acilis|minimum|min\.?|a[cç]ılış|son\s+fiyat|a[cç][ıi]yorum)/i;

const IG_USER_RE = /@([A-Za-z0-9._]{1,30})/g;

/** OCR / ASR garbage: mostly non-letters, or tiny fragments. */
export function isAuctionNoise(text: string): boolean {
  const t = text.trim();
  // Bare pey numbers («9», «10», «6,5») are valid comment bids
  if (/^\d{1,7}([.,]\d{1,3})?$/.test(t)) return false;
  // Seller flower / bouquet lot-end is intentional signal, not HUD noise.
  if (isSellerFlowerLotEnd(t)) return false;
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

/** Word-ish TL/TRY — never match «tl» inside «mutlaka» / «atlas». */
const CURRENCY_RE =
  /(?:₺|(?:^|[^A-Za-zÇĞİÖŞÜçğıöşü])(?:tl|try)(?=[^A-Za-zÇĞİÖŞÜçğıöşü]|$)|türk\s*liras[ıi]|turk\s*liras[ıi]|\blira(?:s[ıi])?\b)/i;

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
      const n = Number(t);
      // «3 500» from stripping the thousand-dot in «3.500» → 3500
      if (
        matched &&
        current >= 1 &&
        current <= 9 &&
        n >= 100 &&
        n <= 999
      ) {
        current = current * 1000 + n;
      } else {
        current += n;
      }
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
      // «üç bin dört yüz üç bin sekiz yüz» — stop before a second amount
      const nxt = tokens[i];
      if (
        nxt &&
        (nxt in TR_ONES || nxt in TR_TENS || /^\d{1,7}$/.test(nxt))
      ) {
        break;
      }
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
  // Prefer the first amount when ASR lists a range («3400 … 3800») —
  // Math.max used to glue ranges into absurd concatenations before the
  // consumeTrNumberTokens stop; first ask is the safer lot opening.
  return pool[0];
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
  // Market-range chatter is not a single ask amount.
  if (PRICE_RANGE_BIN_RE.test(t)) return undefined;
  if (FOREIGN_CURRENCY_RE.test(t)) return undefined;

  const withCur = t.match(
    /(\d{1,3}(?:[.,]\d{3})+|\d{2,7})\s*(?:tl|₺|try|türk\s*liras[ıi]|turk\s*liras[ıi]|lira(?:s[ıi])?)\b/i,
  );
  if (withCur?.[1]) {
    const raw = withCur[1].replace(/\./g, "").replace(/,/g, "");
    return clampPriceTry(Number(raw));
  }

  // Explicit Turkish thousand-dots near fiyat/lira («3.500 lira», «fiyatımız 3.500»)
  const dotted = t.match(
    /(\d{1,3}(?:\.\d{3})+)(?!,|\d)/,
  );
  if (
    dotted?.[1] &&
    (hasCurrencyMarker(t) || /\bfiyat/i.test(t) || /\blira\b/i.test(t))
  ) {
    return clampPriceTry(Number(dotted[1].replace(/\./g, "")));
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

/**
 * True when a follower comment «aldım» is a real take-it claim (not a question /
 * hypothetical). Prefer under-count: ambiguous questions never claim a lot.
 */
/**
 * OCR/chat typos: «Aldmm», «aldm», «Dnz yldz aldm», «700 u alayım».
 * Expand before aldım / bid detection — never invent non-claim chatter.
 */
export function normalizeClaimOrthography(text: string): string {
  let t = text.trim();
  if (!t) return t;
  // «alayım / alayim» (I'll take it) after a price → aldım
  t = t.replace(/\balay[ıi]m\b/gi, "aldım");
  // Collapsed / doubled m: aldm, aldmm, aldmmm
  t = t.replace(/\baldm+\b/gi, "aldım");
  return t;
}

/** Seller flower / bouquet comment that ends the current lot. */
export function isSellerFlowerLotEnd(text: string): boolean {
  const t = text.trim();
  if (!t || !FLOWER_EMOJI_RE.test(t)) return false;
  // Allow flowers + hearts / sparkles / prayer — reject if real words remain.
  const rest = t
    .replace(FLOWER_EMOJI_RE, "")
    .replace(/[\uFE0F\u200D]/g, "")
    .replace(/[❤️🧡💛💚💙💜🤍🤎🖤💕💖💗💓💞💘💝✨🙏👏🏻👏👍💯🔥⭐🌟\s]/gu, "");
  return rest.length === 0;
}

/**
 * True when `username` is the seller or a sibling/brand handle sharing the same
 * root (e.g. fususvintage ↔ fususvintage.design). Never a sale buyer.
 */
export function isSellerSideHandle(
  username: string | undefined | null,
  sellerUsernames: string | readonly string[] | undefined | null,
): boolean {
  if (!username) return false;
  const sellers = (
    Array.isArray(sellerUsernames)
      ? sellerUsernames
      : sellerUsernames
        ? [sellerUsernames]
        : []
  )
    .map((s) => String(s).trim().replace(/^@/, "").toLowerCase())
    .filter((s) => s.length >= 2);
  if (!sellers.length) return false;
  const u = username.trim().replace(/^@/, "").toLowerCase();
  if (!u) return false;
  for (const s of sellers) {
    if (u === s) return true;
    if (u.startsWith(`${s}.`) || s.startsWith(`${u}.`)) return true;
    const uRoot = u.split(".")[0] ?? u;
    const sRoot = s.split(".")[0] ?? s;
    if (uRoot.length >= 4 && uRoot === sRoot) return true;
  }
  return false;
}

export function isFollowerAldimClaimText(text: string): boolean {
  const t = normalizeClaimOrthography(text.trim());
  if (!t || !ALDIM_WORD_RE.test(t)) return false;
  if (GEC_KALDIM_RE.test(t)) return false;
  if (/\?/.test(t)) return false;
  if (/\bacaba\b/i.test(t)) return false;
  if (/\b(?:mi|mı|mü|mu)\s+ald[ıi]m\b/i.test(t)) return false;
  if (/\bald[ıi]m\s+(?:mi|mı|mü|mu)\b/i.test(t)) return false;
  return true;
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
    "bunu",
    "bunlar",
    "bunun",
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
    "canim",
    "tamam",
    "diycegim",
    "diyecegim",
    "hepsini",
    "var",
    "geldim",
    "sizin",
    "sizde",
    "bravo",
    "hayirli",
    "olsun",
    "gule",
    "kullan",
    "takın",
    "takin",
    "mi",
    "mı",
    "mu",
    "mü",
    "su",
    "şu",
    "o",
    "ama",
    "ile",
    "icin",
    "satildi",
    "satın",
    "satin",
    "senin",
    "benim",
    "bunlar",
  ].map(foldTrToken),
);

/**
 * Nunus / Whisper ASR first-name drift → canonical spoken form for handle match.
 * «bağno»/«Bano» are Banu; do NOT put these in SPOKEN_NAME_STOP.
 */
const SPOKEN_NAME_ASR_ALIASES: Record<string, string> = {
  bagno: "banu",
  bano: "banu",
  seyhna: "sehnaz",
  sehna: "sehnaz",
  cihayranimcim: "cihayra",
  cihayranim: "cihayra",
};

function spokenNameMatchForms(spoken: string): string[] {
  const folded = foldTrToken(spoken.trim());
  if (folded.length < 3) return [];
  const out = [folded];
  const alias = SPOKEN_NAME_ASR_ALIASES[folded];
  if (alias && alias !== folded) out.push(alias);
  return out;
}

function acceptSpokenName(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  // ASR often glues honorific: «Cihayranımcım» → Cihayra, «Banuhanım» → Banu.
  // Avoid JS `/i` with Turkish ı (U+0131). «cım» = c+ı+m; «cığım» = c+ı+ğ+ı+m.
  let name = raw.trim();
  const gluedCim = "c[ıiİI](?:[gğGĞ][ıiİI])?m";
  name = name
    .replace(new RegExp(`han[ıiİI]m(?:${gluedCim})?$`), "")
    .trim();
  // Whisper sometimes drops the leading h: «Cihayra»+«nımcım»
  name = name.replace(new RegExp(`n[ıiİI]m${gluedCim}$`), "").trim();
  name = name.replace(new RegExp(`${gluedCim}$`), "").trim();
  name = name.replace(/(?:bey|abla|abi)$/i, "").trim();
  if (name.length < 3) name = raw.trim();
  if (name.length < 3) return undefined;
  const folded = foldTrToken(name);
  if (SPOKEN_NAME_STOP.has(folded)) return undefined;
  if (/^\d/.test(name)) return undefined;
  // Nonsense ASR tokens that are never real first names → canonical.
  // Keep «Şeyhna» etc. as surface form (aliases still help handle match).
  if (folded === "bagno" || folded === "bano") return "Banu";
  return name;
}

/**
 * True when ASR/transcript looks like a seller verbal win confirm
 * («X hanım sizindir», «Y bey sizde», «hayırlı olsun», …).
 * Future/hypothetical («hayırlı olsun diyeceğim») is NOT a confirm.
 */
export function isVerbalWinPhrase(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 180) return false;
  if (
    /diyece[gğ][iı]m|diyece[gğ]iz|var\s+geldim|mi\s*\?|mi\s+kal[ıi]yor|yazarm[ıi][sş][ıi]m/i.test(
      t,
    )
  ) {
    return false;
  }
  if (VERBAL_WIN_SIZINDIR_RE.test(t)) return true;
  if (VERBAL_WIN_SIZDE_KALDI_RE.test(t)) return true;
  if (VERBAL_WIN_NAME_SIZDE_RE.test(t)) return true;
  if (VERBAL_WIN_NAME_ONLY_SIZDE_RE.test(t)) return true;
  if (VERBAL_WIN_HANIMDA_RE.test(t) && !/\bsenin\s+han/i.test(t)) return true;
  if (VERBAL_WIN_SOFT_SIZDE_RE.test(t)) return true;
  if (VERBAL_WIN_IKISI_DE_RE.test(t) && t.length <= 80) return true;
  if (VERBAL_WIN_PRODUCT_GITTI_RE.test(t) && t.length <= 60) return true;
  if (VERBAL_WIN_BRAVO_RE.test(t)) return true;
  if (VERBAL_WIN_ALDIM_GELDI_RE.test(t)) return true;
  if (VERBAL_WIN_SIZ_BUNU_ALDI_RE.test(t)) return true;
  if (VERBAL_WIN_SIZIN_OLACAK_RE.test(t) && t.length <= 80) return true;
  if (VERBAL_WIN_HAYIRLI_RE.test(t)) {
    // Named confirm, or short bare «(Tamam) hayırlı olsun (canım / güle güle…)»
    if (parseSpokenBuyerName(t)) return true;
    if (t.length <= 56) return true;
    return false;
  }
  // Güle güle: packing confirms («güle güle kullan», «güle güle … X hanımcığım»)
  if (
    VERBAL_WIN_GULE_RE.test(t) &&
    t.length <= 100 &&
    !/de[gğ]i[sş]ik|ama\b|fakat\b/i.test(t)
  ) {
    return true;
  }
  return false;
}

/** Soft verbal confirm with no recoverable spoken name. */
export function isBareVerbalWin(text: string): boolean {
  const t = text.trim();
  if (VERBAL_WIN_BARE_RE.test(t)) return true;
  if (VERBAL_WIN_IKISI_DE_RE.test(t) && !parseSpokenBuyerName(t)) return true;
  if (VERBAL_WIN_SOFT_SIZDE_RE.test(t) && !parseSpokenBuyerName(t)) return true;
  if (VERBAL_WIN_PRODUCT_GITTI_RE.test(t) && t.length <= 60) return true;
  return false;
}

/**
 * Spoken name from win phrases («Mehmet aldı», «satıldı Ayşe»,
 * «Ayşe hanım sizindir», «hayırlı olsun Sevda») — UI / username match only.
 */
export function parseSpokenBuyerName(text: string): string | undefined {
  if (parseBuyerHint(text)) return undefined;
  const patterns = [
    VERBAL_WIN_ALDIM_GELDI_RE,
    VERBAL_WIN_SIZ_BUNU_ALDI_RE,
    VERBAL_WIN_HANIMDA_RE,
    new RegExp(
      `\\b([A-Za-zÇĞİÖŞÜçğıöşüÂâÎîÛû]{2,24})\\s+(?:${HONORIFIC})\\s+(?:sizindir|sizin\\s*dir|sizde)\\b`,
      "i",
    ),
    new RegExp(
      `\\b([A-Za-zÇĞİÖŞÜçğıöşüÂâÎîÛû]{2,24})\\s+(?:${HONORIFIC})\\s+hay[ıi]rl[ıi](?:\\s+u[gğ]urlu)?\\s+olsun`,
      "i",
    ),
    /([A-Za-zÇĞİÖŞÜçğıöşüÂâÎîÛû]{2,24})['']?[ea]\s+hay[ıi]rl[ıi](?:\s+u[gğ]urlu)?\s+olsun/i,
    /hay[ıi]rl[ıi](?:\s+u[gğ]urlu)?\s+olsun\s+([A-Za-zÇĞİÖŞÜçğıöşüÂâÎîÛû]{2,24})/i,
    /\bbravo\s+([A-Za-zÇĞİÖŞÜçğıöşüÂâÎîÛû]{2,24})\b/i,
    /([A-Za-zÇĞİÖŞÜçğıöşüÂâÎîÛû]{2,24})\s+de\s+sizin(?:dir|\s+hay)/i,
    /^([A-Za-zÇĞİÖŞÜçğıöşüÂâÎîÛû]{2,24})\s+sizde[.!?…]*$/i,
    // «Tamam sizde Cihayra…»
    /^tamam[,.]?\s+sizde\s+([A-Za-zÇĞİÖŞÜçğıöşüÂâÎîÛû]{2,24})/i,
    // «güle güle … kullanınız güneş hanımcığım»
    new RegExp(
      `g[uü]le\\s+g[uü]le[\\s\\S]{0,60}?\\b([A-Za-zÇĞİÖŞÜçğıöşüÂâÎîÛû]{2,24})\\s+(?:${HONORIFIC})\\b`,
      "i",
    ),
    /(?:sat[ıi]ld[ıi]|sold(?:\s+to)?)\s+([A-Za-zÇĞİÖŞÜçğıöşüÂâÎîÛû]{2,24})(?=\s|$|,|\d)/i,
    // Named «X aldı» — honorific required so «bunu aldı» never matches
    new RegExp(
      `\\b([A-Za-zÇĞİÖŞÜçğıöşüÂâÎîÛû]{2,24})\\s+(?:${HONORIFIC})\\s+ald[ıi](?!\\s*m)\\b`,
      "i",
    ),
    /([A-Za-zÇĞİÖŞÜçğıöşüÂâÎîÛû]{2,24})['']?da\s+kald[ıi]/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    const name = acceptSpokenName(m?.[1]);
    if (name) return name;
  }
  return undefined;
}

/** Small Levenshtein for ASR typos («Şeyhna» ↔ «Şehnaz»). */
function editDistanceAtMost(a: string, b: string, max: number): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > max) return false;
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = new Array<number>(n + 1);
    cur[0] = i;
    let rowMin = cur[0]!;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(
        (prev[j] ?? 99) + 1,
        (cur[j - 1] ?? 99) + 1,
        (prev[j - 1] ?? 99) + cost,
      );
      rowMin = Math.min(rowMin, cur[j]!);
    }
    if (rowMin > max) return false;
    prev = cur;
  }
  return (prev[n] ?? 99) <= max;
}

function nameTokenMatchesSpoken(spoken: string, token: string): boolean {
  if (!token || token.length < 3) return false;
  if (token === spoken) return true;
  if (token.startsWith(spoken) || spoken.startsWith(token)) return true;
  // ASR typos: «Şeyhna»↔«Şehnaz», «Bano»↔«Banu», «Cihayr»↔«Cihayra».
  if (spoken.length >= 4 && token.length >= 4) {
    const max = spoken.length >= 5 || token.length >= 5 ? 2 : 1;
    return editDistanceAtMost(spoken, token, max);
  }
  if (spoken.length >= 3 && token.length >= 3) {
    return editDistanceAtMost(spoken, token, 1);
  }
  return false;
}

/**
 * Match a spoken first name to a single recent commenter username / display name.
 * Ambiguous or no match → undefined (prefer unknown over inventing).
 */
/** All username hits for a spoken name (unique). Empty / multi = ambiguous. */
export function matchSpokenNameHits(
  spoken: string,
  candidates: Array<{ buyerHint?: string; displayName?: string }>,
): string[] {
  const names = spokenNameMatchForms(spoken);
  if (!names.length) return [];
  const hits: string[] = [];
  for (const c of candidates) {
    const user = (c.buyerHint ?? "").trim().replace(/^@/, "").toLowerCase();
    if (!user) continue;
    const display = c.displayName ? foldTrToken(c.displayName) : "";
    let ok = false;
    for (const name of names) {
      if (display) {
        const displayTokens = display
          .split(/[^a-z0-9]+/)
          .filter((t) => t.length >= 3);
        if (
          display === name ||
          displayTokens.some((t) => nameTokenMatchesSpoken(name, t))
        ) {
          ok = true;
        }
      }
      const foldedUser = foldTrToken(user);
      if (!ok && foldedUser.includes(name)) ok = true;
      if (!ok) {
        const tokens = foldedUser
          .split(/[^a-z0-9]+/)
          .filter((t) => t.length >= 3);
        // Username prefix before trailing digits (halecaloglu1 → halecaloglu)
        const prefix = foldedUser.replace(/\d+$/g, "");
        if (prefix.length >= 3) tokens.push(prefix);
        // First-name glued into handle: banubyktskn ↔ «Banu» / ASR «Bano»
        // (len≥4 — «Bano» must see prefix «banu»)
        if (name.length >= 4 && foldedUser.length >= name.length) {
          tokens.push(foldedUser.slice(0, name.length));
          if (foldedUser.length > name.length) {
            tokens.push(foldedUser.slice(0, name.length + 1));
          }
        }
        ok = tokens.some((t) => nameTokenMatchesSpoken(name, t));
      }
      if (ok) break;
    }
    if (ok) hits.push(user);
  }
  return [...new Set(hits)];
}

export function matchSpokenNameToBuyer(
  spoken: string,
  candidates: Array<{ buyerHint?: string; displayName?: string }>,
): string | undefined {
  const uniq = matchSpokenNameHits(spoken, candidates);
  return uniq.length === 1 ? uniq[0] : undefined;
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

/**
 * «ilk aldım diyene 11» → 11_000 when seller means bin.
 * Prefer explicit bin/currency amounts when present.
 */
export function normalizeAldimDiyeneAmount(
  text: string,
  amountTry: number | undefined,
): number | undefined {
  if (amountTry == null) return undefined;
  if (!ALDIM_DIYENE_ASK_RE.test(text)) return amountTry;
  if (hasCurrencyMarker(text) || /\bbin\b/i.test(text)) return amountTry;
  if (amountTry > 0 && amountTry < 100) return amountTry * 1000;
  return amountTry;
}

/** Seller listing phrase with amount (bin/lira / «… dir»). */
export function isSellerAldimAsk(
  text: string,
  amountTry: number | undefined,
): boolean {
  const amt = normalizeAldimDiyeneAmount(text, amountTry);
  if (amt == null) return false;
  if (!/ald[ıi]m/i.test(text)) return false;
  if (SOLD_RE.test(text)) return false;
  if (ALDIM_DIYENE_ASK_RE.test(text)) return true;
  if (COMMENT_SELLER_ASK_RE.test(text)) return true;
  const hasBin = /\bbin\b/i.test(text);
  const hasCur = hasCurrencyMarker(text);
  return hasBin || hasCur;
}

/** True when comment/transcript is a posted ask, not a follower claim. */
export function isPostedSellerAsk(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (ACILISIMIZ_RE.test(t)) return true;
  if (ALDIM_DIYENE_ASK_RE.test(t)) return true;
  if (COMMENT_SELLER_ASK_RE.test(t)) return true;
  return false;
}

/** Seller counter-accept — not mid-sentence «olur» / «Tamam için» chatter. */
export function isSellerAcceptPhrase(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (ACCEPT_STRONG_RE.test(t)) return true;
  if (/^(tamam|olur|okey|okay|kabul)[.!?…]*$/i.test(t)) return true;
  // Long «Tamam …» without price/olur/bin is packing chatter, not accept.
  if (
    /^tamam\b/i.test(t) &&
    t.length > 28 &&
    !/\bolur\b/i.test(t) &&
    !/\bbin\b/i.test(t) &&
    !/\d{2,7}/.test(t) &&
    !hasCurrencyMarker(t) &&
    !parseBuyerHint(t)
  ) {
    return false;
  }
  // «tamam olur», «tamam 18 bin», «olur 5000»
  if (
    /^(tamam|olur|okey|okay|kabul)\b/i.test(t) &&
    (/\bolur\b/i.test(t) ||
      hasCurrencyMarker(t) ||
      /\bbin\b/i.test(t) ||
      /\d{2,7}/.test(t) ||
      Boolean(parseBuyerHint(t)))
  ) {
    // Reject «Tamam için / tamam mı / tamam da» without price/buyer
    if (
      /^(tamam|olur)\s+(i[cç]in|mi|m[ıi]|da|de|ya|yani|ki)\b/i.test(t) &&
      !hasCurrencyMarker(t) &&
      !/\bbin\b/i.test(t) &&
      !/\d{2,7}/.test(t)
    ) {
      return false;
    }
    return ACCEPT_LEAD_RE.test(t) || /\bolur\b/i.test(t) || /\d/.test(t);
  }
  return false;
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

/** Jewelry / mezat product nouns (Turkish + common ASR mangling). */
const PRODUCT_NOUN_RE =
  /\b(?:kolye|kolyo|kly|k[uü]pe|k[uü]peler|bro[sş]|bilezik|bileklik|y[uü]z[uü]k|yuzuk|set(?:i|imiz)?|u[cç](?:u|umuz)?|zincir|boncuk|inci|akik|ametist|onyx|oniks|kristal|kuvars|kelep[cç]e|halhal|ku[sş]ak|kemer|saat|bros|pendant|ring|necklace)\b/i;

/** Soft ask closers Nunus uses without saying «lira» («700 diyelim», «800 olsun»). */
const SOFT_ASK_CLOSER_RE =
  /\b(?:diyelim|diyece[gğ]im|diyorum|olsun|dedik|diye\s+ce[gğ]im)\b/i;

/** «1 numara 1000 TL» / «2 numara bin iki yüz» tray asks. */
const NUMBERED_LOT_ASK_RE =
  /(\d{1,2})\s*numara\s+(?:(?:fiyat[ıi]?\s*)?(?:ise?\s*)?)?(\d{3,5})\s*(?:tl|₺|try|lira(?:s[ıi])?)?/gi;

/** «1 numara Gamze hanım» / «3 numara Claudia hanım sizindir». */
const NUMBERED_LOT_CONFIRM_RE = new RegExp(
  `(\\d{1,2})\\s*numara\\s+([A-Za-zÇĞİÖŞÜçğıöşüÂâÎîÛû]{2,24})\\s+(?:${HONORIFIC})`,
  "i",
);

const DESCRIPTOR_STOP = new Set(
  [
    "aldim",
    "ben",
    "bir",
    "bu",
    "da",
    "de",
    "ve",
    "ile",
    "icin",
    "icin",
    "tl",
    "try",
    "lira",
    "bin",
    "evet",
    "tamam",
    "lutfen",
    "hanim",
    "bey",
    "numara",
    "fiyat",
    "urun",
    "urunum",
    "cok",
    "guzel",
    "harika",
    "tesekkur",
    "tesekkurler",
    "ayyy",
    "ayy",
    "pardon",
  ].map(foldTrToken),
);

export function extractDescriptorTokens(text: string): string[] {
  const folded = foldTrToken(text);
  const raw = folded
    .replace(/ald[ıi]m/gi, " ")
    .replace(/[0-9]+/g, " ")
    .split(/[^a-zçğıöşü0-9]+/i)
    .map((w) => foldTrToken(w))
    .filter((w) => w.length >= 3 && !DESCRIPTOR_STOP.has(w));
  return [...new Set(raw)].slice(0, 8);
}

export function descriptorOverlapScore(
  a: string[] | undefined,
  b: string[] | undefined,
): number {
  if (!a?.length || !b?.length) return 0;
  const bs = new Set(b);
  let hit = 0;
  for (const t of a) {
    if (bs.has(t)) {
      hit++;
      continue;
    }
    // Soft prefix match («kolye» ↔ «koly»)
    for (const u of bs) {
      if (t.length >= 4 && u.length >= 4 && (t.startsWith(u) || u.startsWith(t))) {
        hit += 0.75;
        break;
      }
    }
  }
  return hit;
}

/**
 * Nunus tray: «1 numara 1000 TL, 2 numara 1200 TL…» → one price_mention per number.
 * Ring-size chatter («15 numara») without a price is ignored.
 */
export function parseNumberedTrayAsks(text: string): ParsedAuctionSignal[] {
  const t = text.trim();
  if (!t || !/\bnumara\b/i.test(t)) return [];
  const out: ParsedAuctionSignal[] = [];
  const seen = new Set<number>();
  NUMBERED_LOT_ASK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = NUMBERED_LOT_ASK_RE.exec(t)) != null) {
    const lotNumber = Number(m[1]);
    const amt = clampPriceTry(Number(m[2]));
    if (
      !Number.isFinite(lotNumber) ||
      lotNumber < 1 ||
      lotNumber > 40 ||
      amt == null ||
      amt < OFFER_AMOUNT_SANITY_MIN_TRY
    ) {
      continue;
    }
    if (seen.has(lotNumber)) continue;
    seen.add(lotNumber);
    const slice = m[0]!.slice(0, 120);
    out.push({
      eventType: "price_mention",
      amountTry: amt,
      lotNumber,
      productHint: `${lotNumber} numara`,
      descriptorTokens: [`numara${lotNumber}`, ...extractDescriptorTokens(slice)],
      confidence: 0.72,
      matched: slice,
      reason: "numbered_lot_ask",
    });
  }
  return out;
}

/** Seller «1 numara Gamze hanım» — verbal confirm for a numbered tray lot. */
export function parseNumberedLotConfirm(
  text: string,
): ParsedAuctionSignal | null {
  const t = text.trim();
  if (!t || !/\bnumara\b/i.test(t)) return null;
  const m = t.match(NUMBERED_LOT_CONFIRM_RE);
  if (!m?.[1] || !m[2]) return null;
  const lotNumber = Number(m[1]);
  if (!Number.isFinite(lotNumber) || lotNumber < 1 || lotNumber > 40) {
    return null;
  }
  // Price asks («1 numara 1000 TL») are not confirms.
  if (parseNumberedTrayAsks(t).some((x) => x.lotNumber === lotNumber)) {
    return null;
  }
  const spoken = acceptSpokenName(m[2]);
  if (!spoken) return null;
  return {
    eventType: "sold",
    lotNumber,
    spokenBuyerName: spoken,
    amountTry: parsePriceTry(t),
    confidence: 0.82,
    matched: t,
    reason: "numbered_lot_verbal_confirm",
    productHint: `${lotNumber} numara`,
  };
}

export function splitAuctionClauses(text: string): string[] {
  const t = text.trim();
  if (!t) return [];
  // Numbered tray lists often use commas between lots.
  if (/\d{1,2}\s*numara/i.test(t) && (t.match(/\d{1,2}\s*numara/gi) ?? []).length >= 2) {
    const parts = t
      .split(/(?=,\s*\d{1,2}\s*numara)|(?=;\s*\d{1,2}\s*numara)|(?=\s+\d{1,2}\s*numara)/i)
      .map((s) => s.replace(/^[,;]\s*/, "").trim())
      .filter(Boolean);
    if (parts.length > 1) return parts;
  }
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
  const tray = parseNumberedTrayAsks(text);
  if (tray.length >= 2 && opts?.source !== "comment") {
    return tray;
  }
  const out: ParsedAuctionSignal[] = [];
  for (const clause of splitAuctionClauses(text)) {
    const s = parseAuctionText(clause, opts);
    if (s) out.push(s);
  }
  // Single numbered ask may still appear alone in a clause.
  if (tray.length === 1 && !out.some((x) => x.reason === "numbered_lot_ask")) {
    out.unshift(tray[0]!);
  }
  return out;
}

export function parseAuctionText(
  text: string,
  opts?: ParseAuctionOpts,
): ParsedAuctionSignal | null {
  const raw = text.trim();
  if (isAuctionNoise(raw)) return null;
  // OCR claim typos («aldm», «alayım») — parse on normalized text.
  const t =
    opts?.source === "comment" ? normalizeClaimOrthography(raw) : raw;

  // Seller çiçek emoji = lot end (before other heuristics).
  if (opts?.source === "comment" && isSellerFlowerLotEnd(raw)) {
    return {
      eventType: "sold",
      confidence: 0.86,
      matched: raw,
      reason: "seller_flower_end",
    };
  }

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
  const amountTryRaw = parsePriceTry(t);
  let amountTry = normalizeAldimDiyeneAmount(t, amountTryRaw) ?? amountTryRaw;
  const buyerHint = parseBuyerHint(t);
  const spokenBuyerName = parseSpokenBuyerName(t);
  const source = opts?.source;
  const descriptors = extractDescriptorTokens(t);

  // Nunus tray confirm («1 numara Gamze hanım») — before generic sold/verbal.
  if (source !== "comment") {
    const numberedConfirm = parseNumberedLotConfirm(t);
    if (numberedConfirm) return numberedConfirm;
    const numberedAsks = parseNumberedTrayAsks(t);
    if (numberedAsks.length === 1) return numberedAsks[0]!;
  }

  // Explicit win / sold (seller confirmation) — requires evidence later
  if (SOLD_RE.test(t)) {
    // Questions («satıldı mı») / «arada kaldım» chatter — never a sale confirm.
    if (
      /\?/.test(t) ||
      ARADA_KALDIM_RE.test(t) ||
      /sat[ıi]ld[ıi]\s*(?:mi|mı|mü|mu)\b/i.test(t) ||
      /(?:mi|mı|mü|mu)\s+sat[ıi]ld/i.test(t)
    ) {
      return null;
    }
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

  // Verbal win confirm (ASR): «X hanım sizindir» / «hayırlı olsun» — no @ required
  if (source !== "comment" && isVerbalWinPhrase(t)) {
    const bare = isBareVerbalWin(t) || !spokenBuyerName;
    const conf = spokenBuyerName
      ? amountTry != null
        ? 0.84
        : 0.8
      : amountTry != null
        ? 0.7
        : 0.62;
    // «4 tane arora 600 bağno hanımda» — keep unit price + quantity (split later).
    let reasonOut = bare ? "verbal_win_bare" : "verbal_win_named";
    let quantity: number | undefined;
    const qtyM = t.match(/(\d{1,2})\s*tane\b/i);
    if (
      spokenBuyerName &&
      amountTry != null &&
      qtyM?.[1] &&
      amountTry >= OFFER_AMOUNT_SANITY_MIN_TRY &&
      amountTry <= OFFER_AMOUNT_SANITY_MAX_TRY
    ) {
      const q = Number(qtyM[1]);
      if (q >= 2 && q <= 12) {
        quantity = q;
        reasonOut = "verbal_win_named_qty";
      }
    }
    return {
      eventType: "sold",
      amountTry,
      buyerHint,
      spokenBuyerName,
      quantity,
      confidence: conf,
      matched: t,
      reason: reasonOut,
    };
  }

  // Posted ask in comments OR transcript («Aldım 50.000₺ dir», «açılışımız…»)
  // Must run before BID_RE so co-host ask posts are never buyer claims.
  if (isPostedSellerAsk(t) && amountTry != null) {
    return {
      eventType: "price_mention",
      amountTry,
      productHint: t.slice(0, 120),
      confidence: hasCurrency || /\bbin\b/i.test(t) ? 0.78 : 0.7,
      matched: t,
      reason: ACILISIMIZ_RE.test(t) ? "acilisim_ask" : "seller_aldim_ask",
    };
  }
  if (isPostedSellerAsk(t) && amountTry == null && ACILISIMIZ_RE.test(t)) {
    return {
      eventType: "price_mention",
      productHint: t.slice(0, 120),
      confidence: 0.55,
      matched: t,
      reason: "acilisim_ask",
    };
  }

  // Seller accept of counter — not «lazım olur» / «yine olur» chatter
  if (source === "transcript" && isSellerAcceptPhrase(t)) {
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

  // Transcript bare «Aldım.» / «Aldım ne dedi?» / «Bu olarak aldım.» — seller talk, not claim
  if (
    source === "transcript" &&
    ALDIM_WORD_RE.test(t) &&
    amountTry == null &&
    !buyerHint &&
    !SOLD_RE.test(t)
  ) {
    return null;
  }

  // Bare numeric comments:
  // - «1»…«20» → tray lot-number claim candidate (reconcile picks tray vs pey)
  // - «9»/«10» pey → still amountTry = n*1000 when no tray match
  // - «800» / «1500» → price bid at face value
  if (source === "comment") {
    const bareNum = t.match(
      /^\s*(\d{1,3}(?:[.,]\d{1,3})?|\d{4,7})\s*(bin)?\s*(tl|₺|try)?\s*$/i,
    );
    if (bareNum) {
      let n = Number(String(bareNum[1]).replace(",", "."));
      const hasBinOrCur = Boolean(bareNum[2] || bareNum[3]);
      if (bareNum[2]) n *= 1000;
      else if (n > 0 && n < 100 && !bareNum[3]) n *= 1000;
      const lotNumber =
        !hasBinOrCur &&
        Number.isInteger(Number(bareNum[1])) &&
        Number(bareNum[1]) >= 1 &&
        Number(bareNum[1]) <= 20
          ? Number(bareNum[1])
          : undefined;
      const amt = clampPriceTry(n);
      if (lotNumber != null) {
        return {
          eventType: "bid",
          amountTry: amt,
          lotNumber,
          buyerHint,
          confidence: 0.64,
          matched: t,
          reason: "comment_lot_number_or_bid",
          productHint: `${lotNumber} numara`,
        };
      }
      if (amt != null) {
        return {
          eventType: "bid",
          amountTry: amt,
          buyerHint,
          confidence: 0.62,
          matched: t,
          reason: "comment_number_bid",
        };
      }
    }
    // «Sitrin 32500» / product-name + pey amount (not a descriptor aldım).
    const namedPey = t.match(
      /^\s*[A-Za-zÇĞİÖŞÜçğıöşüÂâÎîÛû][A-Za-zÇĞİÖŞÜçğıöşüÂâÎîÛû0-9._\-]{1,40}\s+(\d{4,7})\s*$/u,
    );
    if (namedPey?.[1] && !ALDIM_WORD_RE.test(t)) {
      const amt = clampPriceTry(Number(namedPey[1]));
      if (amt != null) {
        return {
          eventType: "bid",
          amountTry: amt,
          buyerHint,
          confidence: 0.63,
          matched: t,
          reason: "comment_named_price_bid",
        };
      }
    }
  }

  // Follower / OCR bids (incl. bare comment «aldım», «18 veririm»)
  if (BID_RE.test(t) || COUNTER_RE.test(t)) {
    const isCounter = COUNTER_RE.test(t);
    const isAldim = ALDIM_WORD_RE.test(t);
    // «geç kaldım» / questions must not claim a lot.
    if (
      source === "comment" &&
      isAldim &&
      !isCounter &&
      !isFollowerAldimClaimText(t)
    ) {
      return null;
    }
    // «32 aldım» bin shorthand (same as bare «32» pey) when no currency/bin word.
    if (
      isAldim &&
      source === "comment" &&
      amountTry != null &&
      amountTry > 0 &&
      amountTry < 100 &&
      !hasCurrency &&
      !/\bbin\b/i.test(t)
    ) {
      amountTry = amountTry * 1000;
    }
    const descClaim =
      isAldim &&
      source === "comment" &&
      descriptors.length > 0 &&
      !isCounter;
    // Comment «aldım 500 TL» with currency/bin but no «dir» → still a claim/bid at that price
    // (follower stating take-it); seller «… dir» already handled above.
    return {
      eventType: "bid",
      amountTry,
      buyerHint,
      descriptorTokens: descriptors.length ? descriptors : undefined,
      productHint: descriptors.length
        ? descriptors.slice(0, 4).join(" ")
        : undefined,
      confidence: amountTry
        ? hasCurrency
          ? 0.72
          : 0.65
        : isAldim
          ? descClaim
            ? 0.66
            : 0.6
          : 0.55,
      matched: t,
      reason: isCounter
        ? "counter_offer"
        : descClaim
          ? "descriptor_aldim_claim"
          : isAldim
            ? "aldim_claim"
            : "bid_phrase",
    };
  }

  // @user + price only when price is not just digits glued from the username
  if (
    buyerHint &&
    amountTry != null &&
    !UNSOLD_RE.test(t) &&
    !CORRECTION_RE.test(t)
  ) {
    const stripped = t
      .replace(new RegExp(`@${buyerHint}`, "i"), "")
      .replace(/[^\d]/g, "");
    const fromUser = buyerHint.replace(/[^\d]/g, "");
    const priceLooksFromUsername =
      fromUser.length > 0 &&
      (stripped === fromUser ||
        stripped.endsWith(fromUser) ||
        fromUser.endsWith(stripped));
    const remainder = t
      .replace(/@\w+/gi, "")
      .replace(/[^A-Za-zÀ-ÿĞğÜüŞşİıÖöÇç0-9]/g, "");
    const mostlyMentionEmoji = remainder.length === 0;
    if (!priceLooksFromUsername && !mostlyMentionEmoji) {
      return {
        eventType: "bid",
        amountTry,
        buyerHint,
        confidence: hasCurrency ? 0.7 : 0.62,
        matched: t,
        reason: "ocr_at_user_price",
      };
    }
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
  // Also: «800 kolye», «Bu da 700 diyelim», «800 olsun» (Nunus soft asks).
  if (
    source === "transcript" &&
    amountTry != null &&
    (PRICE_WORD_RE.test(t) ||
      hasCurrency ||
      /\bbin\b/i.test(t) ||
      PRODUCT_NOUN_RE.test(t) ||
      SOFT_ASK_CLOSER_RE.test(t) ||
      /\bbu\s+da\b|\bbunlar(?:\s+da)?\b/i.test(t))
  ) {
    // Foreign currency / market-range chatter is not a TRY lot ask.
    if (FOREIGN_CURRENCY_RE.test(t) || PRICE_RANGE_BIN_RE.test(t)) {
      return null;
    }
    const hint =
      descriptors.length > 0
        ? descriptors.slice(0, 4).join(" ")
        : t.slice(0, 120);
    return {
      eventType: "price_mention",
      amountTry,
      productHint: hint,
      descriptorTokens: descriptors.length ? descriptors : undefined,
      confidence: hasCurrency || PRODUCT_NOUN_RE.test(t) ? 0.62 : 0.52,
      matched: t,
      reason: PRICE_WORD_RE.test(t) ? "price_mention" : "seller_price_line",
    };
  }

  if (amountTry != null && PRICE_WORD_RE.test(t)) {
    if (FOREIGN_CURRENCY_RE.test(t) || PRICE_RANGE_BIN_RE.test(t)) {
      return null;
    }
    return {
      eventType: "price_mention",
      amountTry,
      productHint: descriptors.length
        ? descriptors.slice(0, 4).join(" ")
        : t.slice(0, 120),
      descriptorTokens: descriptors.length ? descriptors : undefined,
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
  /** Optional display / full name from comment metadata for verbal-win matching. */
  displayName?: string;
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
  lotNumber?: number;
  quantity?: number;
  descriptorTokens?: string[];
};

export type SaleMethod =
  | "aldim_first_comment"
  | "bid_win_confirm"
  | "verbal_win_confirm"
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
  /**
   * Uncertain / ambiguous — persist as status `needs_review` for the operator.
   * Must not inflate sold KPIs until approved.
   */
  needsReview?: boolean;
  /** Short evidence snippet (ASR/comment quote) for the report list. */
  evidenceQuote?: string;
};

/** Same buyer + similar price within this window = one sale (repeated verbal confirms). */
export const SALE_DEDUP_WINDOW_MS = 180_000;

type LotWindow = {
  openMs: number;
  askAmount?: number;
  /** First sane ask when the lot opened — never overwritten by pey/OCR crumbs. */
  openingAskTry?: number;
  /**
   * Ask frozen at the moment a follower «aldım» claimed the lot.
   * Sold price for aldim_first_comment MUST use this — later «700 TL» /
   * «190 TL» chatter must not rewrite the sale.
   */
  claimAskTry?: number;
  productHint?: string;
  lotNumber?: number;
  descriptorTokens?: string[];
  openEventIds: string[];
  /** First OCR «aldım» claimer after ask. */
  aldimClaim?: {
    buyer: string;
    offsetMs: number;
    eventId: string;
    amountTry?: number;
    matched?: string;
    descriptorTokens?: string[];
  };
  bids: BidContext[];
  closed: boolean;
  /**
   * Named verbal («İris hayırlı olsun») that did not match a handle.
   * Emitted as needs_review only if the lot closes without a confident sale
   * (keeps correction / later aldım flows intact).
   */
  namedMissReview?: {
    offsetMs: number;
    spokenBuyerName: string;
    amountTry?: number;
    evidenceEventIds: string[];
    evidenceQuote: string;
    productHint?: string;
    reason: string;
  };
  /** «İkisini de aldım» — second item pending; emit needs_review on next distinct ask. */
  dualClaimPending?: {
    buyer: string;
    offsetMs: number;
    eventId: string;
    matched: string;
  };
};

/** How long an unclaimed sequential intro stays claimable («mavi aldım» later). */
const PENDING_LOT_CLAIM_MS = 12 * 60_000;
const PENDING_LOT_POOL_MAX = 16;

/** Sale price for a claimed fixed-ask lot (never a later crumb below ask). */
function lotSaleAsk(win: LotWindow): number | undefined {
  return win.claimAskTry ?? win.askAmount ?? win.openingAskTry;
}

/**
 * Reject ASR/OCR amounts that are absurdly below the lot ask unless the
 * seller explicitly accepted a counter at that price.
 */
function resolveSaleAmountTry(opts: {
  askTry?: number;
  eventAmountTry?: number;
  method: SaleMethod;
}): number | undefined {
  const { askTry, eventAmountTry, method } = opts;
  if (method === "counter_accept" && eventAmountTry != null) {
    return eventAmountTry;
  }
  // Named packing «… 600 bağno hanımda» while another ask is open — seller
  // stated this sale's price; do not overwrite with the unrelated lot ask.
  if (method === "verbal_win_confirm" && eventAmountTry != null) {
    return eventAmountTry;
  }
  if (askTry == null) return eventAmountTry;
  if (eventAmountTry == null) return askTry;
  // Fixed-ask aldım: sold price is the claim/opening ask, not OCR chatter
  if (method === "aldim_first_comment") return askTry;
  // Bidding up (or equal) is fine
  if (eventAmountTry >= askTry) return eventAmountTry;
  // Same ballpark below ask (ASR jitter) → prefer ask
  if (amountsNear(eventAmountTry, askTry)) return askTry;
  // Far below ask without counter-accept → keep the ask (never sell 2200→700)
  return askTry;
}

/**
 * ASR sometimes concatenates repeated «bin beş yüz» into absurd TRY amounts
 * (e.g. 501_500, 1_002_000). Exclude those from ask-sum KPIs only.
 */
export const OFFER_AMOUNT_SANITY_MAX_TRY = 100_000;
/** Bare pey digits / ASR crumbs («15», «45») are not mezat opening asks. */
export const OFFER_AMOUNT_SANITY_MIN_TRY = 500;

/** Same/similar ask within this window = re-show (camera pan / rotate), not a new lot. */
export const LOT_RESHOW_MERGE_MS = 180_000;
/**
 * Min open duration before a different ask may start a new lot.
 * 75s starved glam (~13 lots / 50 min); 40s still blocks rapid restatement phantoms.
 * Prefer under-merge of distinct products over under-count of offered.
 */
export const LOT_MIN_NEW_MS = 40_000;
/** Amount change this soon after open = price revise on the same product. */
export const LOT_EARLY_REVISE_MS = 45_000;
/**
 * Relative tolerance for “similar” ask on bare restatements.
 * 20% merged glam 2000↔2500 and 2500↔3000 (common mezat steps). Prefer ~10%
 * so camera re-shows of the *same* ask still merge, but adjacent products split.
 * Product-cued lines at a different TRY still open a new lot even inside this band.
 */
export const LOT_AMOUNT_NEAR_RATIO = 0.1;

export type ProductLot = {
  openMs: number;
  closeMs: number;
  /** First settled ask for the lot — used once in totalAskTry. */
  openingAskTry: number;
  eventIds: string[];
  productHint?: string;
};

function amountsNear(a: number, b: number): boolean {
  if (a === b) return true;
  const denom = Math.max(a, b, 1);
  return Math.abs(a - b) / denom <= LOT_AMOUNT_NEAR_RATIO;
}

/**
 * Collapse repeated confirms: same buyer + similar price within
 * SALE_DEDUP_WINDOW_MS → keep the first (one sale per lot).
 */
export function dedupeSaleCandidates(sales: SaleCandidate[]): SaleCandidate[] {
  const out: SaleCandidate[] = [];
  for (const s of sales) {
    const dup = out.find((o) => {
      // Confirmed vs needs_review are distinct operator rows (glam dual 2000+2500).
      if (Boolean(o.needsReview) !== Boolean(s.needsReview)) return false;
      if (!o.buyerUsername || o.buyerUsername !== s.buyerUsername) return false;
      // Multi-item qty / dual legs must not collapse («4 tane 600» → 4 rows).
      const oQty = (o.reason ?? "").match(/qty_(\d+)_of_(\d+)/);
      const sQty = (s.reason ?? "").match(/qty_(\d+)_of_(\d+)/);
      if (oQty || sQty) {
        // Different packing legs, or qty vs prior single — keep both.
        if (!oQty || !sQty) return false;
        if (oQty[1] !== sQty[1]) return false;
      }
      if (
        /dual_same_price_leg_|dual_same_price_second/.test(o.reason ?? "") ||
        /dual_same_price_leg_|dual_same_price_second/.test(s.reason ?? "")
      ) {
        if ((o.reason ?? "") !== (s.reason ?? "")) return false;
      }
      if (o.amountTry == null || s.amountTry == null) {
        return Math.abs(o.offsetMs - s.offsetMs) <= SALE_DEDUP_WINDOW_MS;
      }
      return (
        amountsNear(o.amountTry, s.amountTry) &&
        Math.abs(o.offsetMs - s.offsetMs) <= SALE_DEDUP_WINDOW_MS
      );
    });
    if (dup) continue;
    out.push(s);
  }
  return out;
}

export type ReconcileMezatOpts = {
  /** Seller IG handle(s); never become buyerUsername (incl. sibling brand roots). */
  sellerUsernames?: string | readonly string[];
};

/**
 * Product-window reconcile: seller ask ≠ sale; first comment aldım wins;
 * pey escalate to highest bid before seller end-marker; flower emoji closes lot;
 * bid+confirm; verbal win («sizindir»); counter+accept.
 * Prefer no sale over inventing. Repeated verbal confirms → one sale.
 * Never attribute a sale to the seller / brand sibling handles.
 */
export function reconcileMezatWindows(
  events: TimelineEvent[],
  opts?: ReconcileMezatOpts,
): SaleCandidate[] {
  const sellerUsernames = opts?.sellerUsernames;
  const isSellerBuyer = (u: string | undefined | null) =>
    isSellerSideHandle(u, sellerUsernames);
  const sorted = [...events].sort((a, b) => a.offsetMs - b.offsetMs);
  const sales: SaleCandidate[] = [];
  let win: LotWindow | null = null;
  /** Parallel Nunus tray lots («1 numara…», «2 numara…») awaiting number claims. */
  const trayLots = new Map<number, LotWindow>();
  /** Sequential intros parked when the next product opens (descriptor claims later). */
  let pendingUnclaimed: LotWindow[] = [];
  /** Recent sane asks for filling needs_review amounts when the lot window is gone. */
  const recentAsks: Array<{ offsetMs: number; amountTry: number; hint?: string }> =
    [];
  /** Rolling commenter pool for «X hanımda» name→@handle matching (Nunus). */
  const recentCommenters: Array<{
    buyerHint: string;
    offsetMs: number;
    eventId?: string;
    amountTry?: number;
  }> = [];
  /** Aldım comments that arrived with no open lot (often just before the ask). */
  const orphanClaims: Array<{
    buyer: string;
    offsetMs: number;
    eventId: string;
    amountTry?: number;
    matched?: string;
    descriptorTokens?: string[];
    lotNumber?: number;
  }> = [];
  /** Claim discarded by a correction/void pass — re-attach to restated ask. */
  let carryClaim: {
    buyer: string;
    offsetMs: number;
    eventId: string;
    amountTry?: number;
    matched?: string;
    descriptorTokens?: string[];
  } | null = null;
  /** Dual-claim («ikisini de» / A+B=C) awaiting a second distinct ask. */
  let pendingDualReview: {
    buyer: string;
    offsetMs: number;
    eventId: string;
    matched: string;
    secondAmountTry?: number;
  } | null = null;

  const pushNeedsReview = (cand: SaleCandidate) => {
    const amountTry = cand.amountTry ?? cand.askAmountTry;
    const askAmountTry = cand.askAmountTry ?? cand.amountTry;
    sales.push({
      ...cand,
      amountTry,
      askAmountTry,
      needsReview: true,
    });
  };

  /** Emit one sale per packing unit («4 tane … 600» → 4×600). */
  const pushSaleUnits = (
    cand: SaleCandidate,
    quantity: number | undefined,
    opts?: { needsReview?: boolean },
  ) => {
    const unit = cand.amountTry ?? cand.askAmountTry;
    const q =
      quantity != null && quantity >= 2 && quantity <= 12 && unit != null
        ? quantity
        : 1;
    for (let i = 0; i < q; i++) {
      const row: SaleCandidate = {
        ...cand,
        offsetMs: cand.offsetMs + i,
        amountTry: unit,
        askAmountTry: unit ?? cand.askAmountTry,
        reason:
          q > 1
            ? `${cand.reason ?? "sold"}+qty_${i + 1}_of_${q}`
            : cand.reason,
        evidenceQuote:
          q > 1 && cand.evidenceQuote
            ? `${cand.evidenceQuote} (${i + 1}/${q})`
            : cand.evidenceQuote,
      };
      if (opts?.needsReview) pushNeedsReview(row);
      else sales.push(row);
    }
  };

  const emitNamedMiss = (lot: LotWindow) => {
    if (!lot.namedMissReview) return;
    const m = lot.namedMissReview;
    const amt = m.amountTry ?? lot.askAmount ?? lot.openingAskTry;
    sales.push({
      offsetMs: m.offsetMs,
      amountTry: amt,
      spokenBuyerName: m.spokenBuyerName,
      confidence: 0.58,
      reason: m.reason,
      saleMethod: "verbal_win_confirm",
      evidenceEventIds: [...new Set([...m.evidenceEventIds, ...lot.openEventIds])],
      productHint: m.productHint ?? lot.productHint,
      askAmountTry: amt,
      needsReview: true,
      evidenceQuote: m.evidenceQuote,
    });
    lot.namedMissReview = undefined;
  };

  const flushNamedMissIfPending = () => {
    if (!win) return;
    emitNamedMiss(win);
  };

  /**
   * Highest follower pey above the ask/claim floor. When present, that bidder
   * outranks an earlier «32 aldım» claim (fusus ~85min).
   */
  const pickHighestPeyBid = (
    lot: LotWindow,
  ): {
    buyer: string;
    amountTry: number;
    offsetMs: number;
    eventId?: string;
  } | null => {
    const floor =
      lotSaleAsk(lot) ??
      (lot.aldimClaim?.amountTry != null
        ? saneAskAmount(lot.aldimClaim.amountTry)
        : undefined);
    let best: {
      buyer: string;
      amountTry: number;
      offsetMs: number;
      eventId?: string;
    } | null = null;
    for (const b of lot.bids) {
      if (b.source !== "comment" || !b.buyerHint || b.amountTry == null) continue;
      if (isSellerBuyer(b.buyerHint)) continue;
      const amt = saneAskAmount(b.amountTry);
      if (amt == null) continue;
      if (floor != null && amt <= floor) continue;
      if (
        !best ||
        amt > best.amountTry ||
        (amt === best.amountTry && b.offsetMs >= best.offsetMs)
      ) {
        best = {
          buyer: b.buyerHint,
          amountTry: amt,
          offsetMs: b.offsetMs,
          eventId: b.eventId,
        };
      }
    }
    return best;
  };

  const emitAldimSale = (lot: LotWindow) => {
    const hasCounter = lot.bids.some((b) => b.reason === "counter_offer");
    const saleAsk =
      lotSaleAsk(lot) ??
      lot.aldimClaim?.amountTry ??
      saneAskAmount(lot.aldimClaim?.amountTry);
    const pey = pickHighestPeyBid(lot);
    // Pey escalate: later higher bids beat the first priced aldım claim.
    if (pey && !hasCounter) {
      sales.push({
        offsetMs: pey.offsetMs,
        amountTry: pey.amountTry,
        buyerUsername: pey.buyer,
        confidence: 0.9,
        reason: "pey_escalate_highest_bid",
        saleMethod: "bid_win_confirm",
        evidenceEventIds: [
          ...lot.openEventIds,
          ...(lot.aldimClaim ? [lot.aldimClaim.eventId] : []),
          ...(pey.eventId ? [pey.eventId] : []),
        ],
        productHint: lot.productHint,
        askAmountTry: lot.openingAskTry ?? saleAsk ?? pey.amountTry,
        evidenceQuote: `@${pey.buyer} pey ${pey.amountTry} TRY (çiçek/en yüksek)`,
      });
      lot.namedMissReview = undefined;
      return true;
    }
    if (lot.aldimClaim && saleAsk != null && !hasCounter) {
      if (isSellerBuyer(lot.aldimClaim.buyer)) {
        emitNamedMiss(lot);
        return false;
      }
      sales.push({
        offsetMs: lot.aldimClaim.offsetMs,
        amountTry: saleAsk,
        buyerUsername: lot.aldimClaim.buyer,
        confidence: 0.88,
        reason: lot.lotNumber != null
          ? "numbered_lot_claim+ask_price"
          : lot.aldimClaim.descriptorTokens?.length
            ? "descriptor_aldim_claim+ask_price"
            : "aldim_first_comment+ask_price",
        saleMethod: "aldim_first_comment",
        evidenceEventIds: [...lot.openEventIds, lot.aldimClaim.eventId],
        productHint: lot.productHint,
        askAmountTry: lot.openingAskTry ?? saleAsk,
        evidenceQuote:
          lot.aldimClaim.matched?.slice(0, 200) ??
          `@${lot.aldimClaim.buyer} aldım → ${saleAsk} TRY`,
      });
      lot.namedMissReview = undefined;
      return true;
    }
    emitNamedMiss(lot);
    return false;
  };

  const parkUnclaimedLot = (lot: LotWindow, atMs: number) => {
    if (lot.closed || lot.aldimClaim) return;
    // Bids without a confident aldım/verbal confirm → operator review (priced).
    const ask = lotSaleAsk(lot);
    const bidBuyers = lot.bids
      .filter(
        (b) =>
          b.buyerHint &&
          b.source === "comment" &&
          !isSellerBuyer(b.buyerHint),
      )
      .map((b) => ({
        buyer: b.buyerHint!,
        offsetMs: b.offsetMs,
        eventId: b.eventId,
        amountTry: b.amountTry,
      }));
    if (ask != null && bidBuyers.length > 0 && !lot.namedMissReview) {
      const last = bidBuyers[bidBuyers.length - 1]!;
      pushNeedsReview({
        offsetMs: last.offsetMs,
        amountTry: saneAsk(last.amountTry) ?? ask,
        buyerUsername: last.buyer,
        confidence: 0.52,
        reason: "bid_without_confirm_needs_review",
        saleMethod: "bid_win_confirm",
        evidenceEventIds: [
          ...lot.openEventIds,
          ...(last.eventId ? [last.eventId] : []),
        ],
        productHint: lot.productHint,
        askAmountTry: ask,
        evidenceQuote: `@${last.buyer} teklif / onay belirsiz → ${ask} TRY`,
      });
    } else if (
      ask != null &&
      bidBuyers.length === 0 &&
      !lot.namedMissReview &&
      atMs - lot.openMs >= 20_000 &&
      ((lot.descriptorTokens?.length ?? 0) > 0 ||
        PRODUCT_NOUN_RE.test(lot.productHint ?? ""))
    ) {
      // Priced product intro that never got a clear claim — operator may know
      // a verbal sale the ASR missed.
      pushNeedsReview({
        offsetMs: lot.openMs,
        amountTry: ask,
        confidence: 0.46,
        reason: "unclaimed_product_ask_needs_review",
        saleMethod: "sold_phrase",
        evidenceEventIds: [...lot.openEventIds],
        productHint: lot.productHint,
        askAmountTry: ask,
        evidenceQuote: (lot.productHint ?? `Ask ${ask} TRY`).slice(0, 200),
      });
    }
    lot.closed = true;
    pendingUnclaimed.push(lot);
    // End-of-timeline (MAX_SAFE_INTEGER) must keep parked lots so named-miss /
    // late descriptor claims can still flush — only age-filter on real clocks.
    if (atMs < Number.MAX_SAFE_INTEGER / 2) {
      pendingUnclaimed = pendingUnclaimed
        .filter((p) => atMs - p.openMs <= PENDING_LOT_CLAIM_MS)
        .slice(-PENDING_LOT_POOL_MAX);
    } else {
      pendingUnclaimed = pendingUnclaimed.slice(-PENDING_LOT_POOL_MAX);
    }
  };

  const flushAldimIfClaimed = (closeMs: number) => {
    if (!win || win.closed) return;
    if (win.aldimClaim) {
      emitAldimSale(win);
      win.closed = true;
      win = null;
    } else {
      // Keep unclaimed sequential intros alive for later descriptor / amount claims.
      parkUnclaimedLot(win, closeMs);
      win = null;
    }
    void closeMs;
  };

  const flushTrayLots = (closeMs: number) => {
    for (const lot of trayLots.values()) {
      if (lot.closed) continue;
      if (lot.aldimClaim) emitAldimSale(lot);
      else parkUnclaimedLot(lot, closeMs);
      lot.closed = true;
    }
    trayLots.clear();
  };

  const saneAsk = (n: number | undefined): number | undefined => {
    if (n == null || !Number.isFinite(n)) return undefined;
    if (n < OFFER_AMOUNT_SANITY_MIN_TRY || n > OFFER_AMOUNT_SANITY_MAX_TRY) {
      return undefined;
    }
    return n;
  };
  const saneAskAmount = saneAsk;

  const freezeClaimAskOn = (lot: LotWindow) => {
    if (lot.claimAskTry != null) return;
    const a = lot.askAmount ?? lot.openingAskTry;
    if (a != null) lot.claimAskTry = a;
  };

  const freezeClaimAsk = () => {
    if (!win) return;
    freezeClaimAskOn(win);
  };

  const attachPendingClaim = (openMs: number) => {
    if (!win || win.aldimClaim) return;
    if (
      carryClaim &&
      openMs - carryClaim.offsetMs >= 0 &&
      openMs - carryClaim.offsetMs <= ALDIM_CARRY_AFTER_CORRECTION_MS
    ) {
      win.aldimClaim = { ...carryClaim };
      carryClaim = null;
      freezeClaimAsk();
      return;
    }
    // Orphan aldım shortly before (or tiny after) this ask
    for (let i = orphanClaims.length - 1; i >= 0; i--) {
      const o = orphanClaims[i]!;
      const dt = openMs - o.offsetMs;
      if (dt >= 0 && dt <= ALDIM_PRE_ASK_MS) {
        win.aldimClaim = { ...o };
        orphanClaims.splice(i, 1);
        freezeClaimAsk();
        return;
      }
      if (dt < 0 && o.offsetMs - openMs <= 5_000) {
        win.aldimClaim = { ...o };
        orphanClaims.splice(i, 1);
        freezeClaimAsk();
        return;
      }
    }
  };

  const claimLot = (
    lot: LotWindow,
    claim: NonNullable<LotWindow["aldimClaim"]>,
  ) => {
    if (lot.aldimClaim) return false;
    lot.aldimClaim = claim;
    freezeClaimAskOn(lot);
    if (
      claim.amountTry != null &&
      saneAsk(claim.amountTry) != null &&
      lot.askAmount == null
    ) {
      lot.askAmount = claim.amountTry;
      lot.openingAskTry = claim.amountTry;
      lot.claimAskTry = claim.amountTry;
    }
    return true;
  };

  const findPendingMatch = (opts: {
    offsetMs: number;
    amountTry?: number;
    descriptorTokens?: string[];
  }): LotWindow | null => {
    pendingUnclaimed = pendingUnclaimed.filter(
      (p) => opts.offsetMs - p.openMs <= PENDING_LOT_CLAIM_MS && !p.aldimClaim,
    );
    let best: LotWindow | null = null;
    let bestScore = 0;
    for (const p of pendingUnclaimed) {
      let score = 0;
      const ask = lotSaleAsk(p);
      if (
        opts.amountTry != null &&
        ask != null &&
        (opts.amountTry === ask || amountsNear(opts.amountTry, ask))
      ) {
        score += 3;
      }
      score += descriptorOverlapScore(
        opts.descriptorTokens,
        p.descriptorTokens ?? extractDescriptorTokens(p.productHint ?? ""),
      );
      if (score > bestScore) {
        bestScore = score;
        best = p;
      }
    }
    if (!best || bestScore < 1) return null;
    pendingUnclaimed = pendingUnclaimed.filter((p) => p !== best);
    best.closed = false;
    return best;
  };

  const rememberAsk = (
    offsetMs: number,
    amount: number | undefined,
    hint?: string,
  ) => {
    const a = saneAsk(amount);
    if (a == null) return;
    recentAsks.push({ offsetMs, amountTry: a, hint });
    if (recentAsks.length > 40) recentAsks.shift();
  };

  const nearestRecentAsk = (
    offsetMs: number,
  ): { amountTry: number; hint?: string } | undefined => {
    let best: { amountTry: number; hint?: string; dt: number } | undefined;
    for (const a of recentAsks) {
      const dt = offsetMs - a.offsetMs;
      if (dt < -15_000 || dt > PENDING_LOT_CLAIM_MS) continue;
      const adt = Math.abs(dt);
      if (!best || adt < best.dt) {
        best = { amountTry: a.amountTry, hint: a.hint, dt: adt };
      }
    }
    return best
      ? { amountTry: best.amountTry, hint: best.hint }
      : undefined;
  };

  const openLot = (ev: TimelineEvent, ask?: number) => {
    const prevDual = win?.dualClaimPending ?? pendingDualReview;
    // Numbered tray batch: keep siblings open together.
    if (ev.lotNumber != null && ev.reason === "numbered_lot_ask") {
      if (win && !win.closed && win.lotNumber == null) {
        flushAldimIfClaimed(ev.offsetMs);
      }
      const opening = saneAsk(ask ?? ev.amountTry);
      const lot: LotWindow = {
        openMs: ev.offsetMs,
        askAmount: opening,
        openingAskTry: opening,
        productHint:
          ev.productHint ??
          (ev.lotNumber != null
            ? `${ev.lotNumber} numara`
            : ev.matched.slice(0, 120)),
        lotNumber: ev.lotNumber,
        descriptorTokens:
          ev.descriptorTokens ??
          extractDescriptorTokens(ev.productHint ?? ev.matched),
        openEventIds: [ev.id],
        bids: [],
        closed: false,
      };
      const prev = trayLots.get(ev.lotNumber);
      if (prev && !prev.closed && !prev.aldimClaim) {
        parkUnclaimedLot(prev, ev.offsetMs);
      } else if (prev && !prev.closed && prev.aldimClaim) {
        emitAldimSale(prev);
        prev.closed = true;
      }
      trayLots.set(ev.lotNumber, lot);
      win = lot;
      rememberAsk(ev.offsetMs, opening, lot.productHint);
      attachPendingClaim(ev.offsetMs);
      return;
    }

    if (trayLots.size > 0 && ev.lotNumber == null) {
      flushTrayLots(ev.offsetMs);
    }
    flushAldimIfClaimed(ev.offsetMs);
    const opening = saneAsk(ask ?? ev.amountTry);
    win = {
      openMs: ev.offsetMs,
      askAmount: opening,
      openingAskTry: opening,
      productHint: ev.productHint ?? ev.matched.slice(0, 120),
      lotNumber: ev.lotNumber,
      descriptorTokens:
        ev.descriptorTokens ??
        extractDescriptorTokens(ev.productHint ?? ev.matched),
      openEventIds: [ev.id],
      bids: [],
      closed: false,
    };
    rememberAsk(ev.offsetMs, opening, win.productHint);
    attachPendingClaim(ev.offsetMs);
    // Dual «ikisini de» / sum comment → second distinct ask is needs_review (not auto-sold).
    if (
      prevDual &&
      opening != null &&
      (prevDual.secondAmountTry == null ||
        amountsNear(opening, prevDual.secondAmountTry) ||
        opening === prevDual.secondAmountTry)
    ) {
      const age = ev.offsetMs - prevDual.offsetMs;
      if (age >= 0 && age <= SALE_DEDUP_WINDOW_MS) {
        pushNeedsReview({
          offsetMs: prevDual.offsetMs,
          amountTry: prevDual.secondAmountTry ?? opening,
          buyerUsername: prevDual.buyer,
          confidence: 0.55,
          reason: "dual_claim_second_item_needs_review",
          saleMethod: "aldim_first_comment",
          evidenceEventIds: [prevDual.eventId, ev.id],
          productHint: win.productHint,
          askAmountTry: prevDual.secondAmountTry ?? opening,
          evidenceQuote: prevDual.matched.slice(0, 200),
        });
        pendingDualReview = null;
      }
    } else if (prevDual && !win.dualClaimPending) {
      pendingDualReview = prevDual;
    }
  };

  for (const ev of sorted) {
    const reason = ev.reason ?? "";

    if (ev.eventType === "pass") {
      if (win && !win.closed) {
        // Early correction of a bad ask (claim still hot) → re-attach to restated
        // price. Late «özür / yanlış söyledim» about a *different* item must not
        // erase an already-frozen aldım sale (glam trifari apology vs bilezik).
        const claimAgeMs = win.aldimClaim
          ? ev.offsetMs - win.aldimClaim.offsetMs
          : Number.POSITIVE_INFINITY;
        if (
          win.aldimClaim &&
          reason === "correction_or_void" &&
          claimAgeMs <= ALDIM_CARRY_AFTER_CORRECTION_MS
        ) {
          carryClaim = { ...win.aldimClaim };
          win.namedMissReview = undefined;
          win.closed = true;
          win = null;
        } else {
          // Claimed lot → emit sale at frozen ask; unclaimed → named-miss only.
          flushAldimIfClaimed(ev.offsetMs);
        }
      }
      continue;
    }

    if (
      ev.eventType === "price_mention" ||
      ev.eventType === "item_intro"
    ) {
      const askAmt = ev.amountTry;
      const strongAsk =
        reason === "seller_aldim_ask" ||
        reason === "acilisim_ask" ||
        reason === "price_mention" ||
        reason === "numbered_lot_ask" ||
        (ev.eventType === "item_intro" && askAmt != null);

      // Numbered tray asks always open/refresh their slot (even mid-window).
      if (reason === "numbered_lot_ask" && ev.lotNumber != null) {
        openLot(ev, askAmt);
        continue;
      }

      // No open window → only a *sane* ask opens a lot (refuse «190 TL» crumbs)
      if (!win || win.closed) {
        const openingAmt = saneAsk(askAmt);
        if (
          openingAmt != null ||
          (ev.eventType === "item_intro" && askAmt == null)
        ) {
          openLot(ev, askAmt);
        }
        continue;
      }

      const dtSinceOpen = ev.offsetMs - win.openMs;
      const saneAmt = saneAsk(askAmt);
      // Lot opened without a usable ask (legacy) — adopt the first sane price
      if (win.askAmount == null && saneAmt != null) {
        win.askAmount = saneAmt;
        win.openingAskTry = saneAmt;
        win.openEventIds.push(ev.id);
        continue;
      }
      const opening = win.openingAskTry ?? win.askAmount;
      const lastAsk = win.askAmount ?? opening;
      const near =
        askAmt != null &&
        win.askAmount != null &&
        amountsNear(askAmt, win.askAmount);
      const exactAsk =
        askAmt != null &&
        (askAmt === win.askAmount || askAmt === win.openingAskTry);
      const productCue = isLotOpeningPriceLine(ev.matched);
      const farBelowOpening =
        saneAmt != null &&
        opening != null &&
        saneAmt < opening &&
        !amountsNear(saneAmt, opening) &&
        saneAmt / opening < 0.55;

      // Product-cued / strong different ask → next lot (aligned with buildProductLots)
      if (
        saneAmt != null &&
        opening != null &&
        lastAsk != null &&
        shouldOpenNewProductLot({
          matched: ev.matched,
          amount: saneAmt,
          openingAsk: opening,
          lastAsk,
          dtOpen: dtSinceOpen,
          strong: strongAsk || (reason === "seller_price_line" && productCue),
        })
      ) {
        openLot(ev, saneAmt);
        continue;
      }

      // Re-show / restatement of same or similar ask → stay on this lot
      if ((near || exactAsk) && dtSinceOpen <= LOT_RESHOW_MERGE_MS) {
        win.openEventIds.push(ev.id);
        continue;
      }

      // Strong ask with a clearly different amount = next product (flush aldım claim)
      if (
        strongAsk &&
        askAmt != null &&
        win.askAmount != null &&
        !near &&
        !exactAsk
      ) {
        openLot(ev, askAmt);
        continue;
      }

      // After a follower claimed the lot, never rewrite the ask from later crumbs
      // («700 TL.» / «anlaşmalı 190 TL») — that is the glam 2200→700 / 2000→190 bug.
      // A sane different ask (≥55% of opening, or product-cued) starts the next lot
      // so the next buyer’s aldım is not orphaned on the sold window.
      if (win.aldimClaim || win.claimAskTry != null) {
        if (
          saneAmt != null &&
          win.askAmount != null &&
          !near &&
          !exactAsk &&
          dtSinceOpen >= LOT_PRODUCT_CUE_MIN_MS &&
          (!farBelowOpening || strongAsk || productCue)
        ) {
          openLot(ev, saneAmt);
          continue;
        }
        if (askAmt != null) win.openEventIds.push(ev.id);
        continue;
      }

      // Weak price-line early revise on the same product — keep window
      // (only sane amounts; refuse pey crumbs / product-cued next items).
      if (
        reason === "seller_price_line" &&
        saneAmt != null &&
        dtSinceOpen <= LOT_EARLY_REVISE_MS &&
        !farBelowOpening &&
        !productCue
      ) {
        win.askAmount = saneAmt;
        if (win.openingAskTry == null) win.openingAskTry = saneAmt;
        win.openEventIds.push(ev.id);
        continue;
      }

      // Far-below crumb without product cue → ignore (do not sell 2200 at 700).
      // With product cue → next lot (floor already applied in shouldOpenNewProductLot).
      if (farBelowOpening) {
        if (productCue || strongAsk) {
          openLot(ev, saneAmt);
          continue;
        }
        if (askAmt != null) win.openEventIds.push(ev.id);
        continue;
      }

      // Same-lot price cut / bump («2000 lira» after a 4200 ask) without product cue —
      // update ask in place rather than inventing a phantom next lot.
      if (
        reason === "seller_price_line" &&
        saneAmt != null &&
        win.askAmount != null &&
        !near &&
        dtSinceOpen <= 5 * 60_000 &&
        !productCue
      ) {
        win.askAmount = saneAmt;
        win.openEventIds.push(ev.id);
        continue;
      }

      // Otherwise absorb into current lot (bare crumbs only)
      if (askAmt != null) {
        win.openEventIds.push(ev.id);
      }
      continue;
    }

    if (ev.eventType === "bid") {
      // Re-validate claim text so stale/bad segments («gec kaldim») cannot invent sales.
      const claimTextOk = isFollowerAldimClaimText(ev.matched);
      const isAldimClaim =
        claimTextOk &&
        (reason === "aldim_claim" ||
          reason === "descriptor_aldim_claim" ||
          (ALDIM_WORD_RE.test(ev.matched) && ev.amountTry == null));
      const dualSum =
        ev.source === "comment" ? parseDualClaimSum(ev.matched) : undefined;
      const dualAldim =
        ev.source === "comment" && isDualAldimClaimText(ev.matched);
      const descTokens =
        ev.descriptorTokens ?? extractDescriptorTokens(ev.matched);
      // Seller / brand sibling comments are asks or chatter — never buyer evidence.
      const buyerHint = isSellerBuyer(ev.buyerHint) ? undefined : ev.buyerHint;

      // Track commenters for later verbal «X hanımda» matching.
      if (ev.source === "comment" && buyerHint) {
        recentCommenters.push({
          buyerHint,
          offsetMs: ev.offsetMs,
          eventId: ev.id,
          amountTry: ev.amountTry,
        });
        if (recentCommenters.length > 80) recentCommenters.shift();
      }

      // Nunus: bare price comment matching the open ask («800» after «800 lira»)
      // is a soft take-it claim (buyers often omit «aldım»).
      if (
        ev.source === "comment" &&
        buyerHint &&
        win &&
        !win.closed &&
        !win.aldimClaim &&
        reason === "comment_number_bid" &&
        ev.amountTry != null &&
        lotSaleAsk(win) != null &&
        (ev.amountTry === lotSaleAsk(win) ||
          amountsNear(ev.amountTry, lotSaleAsk(win)!)) &&
        ev.offsetMs - win.openMs <= ALDIM_CLAIM_WINDOW_MS
      ) {
        claimLot(win, {
          buyer: buyerHint,
          offsetMs: ev.offsetMs,
          eventId: ev.id,
          amountTry: lotSaleAsk(win),
          matched: ev.matched,
        });
        win.bids.push({
          offsetMs: ev.offsetMs,
          amountTry: ev.amountTry,
          buyerHint: buyerHint,
          source: ev.source,
          reason: "price_match_claim",
          eventId: ev.id,
        });
        continue;
      }

      // Nunus tray: bare «1» / «3» claims the matching open number (first buyer wins).
      if (
        ev.source === "comment" &&
        buyerHint &&
        ev.lotNumber != null &&
        (reason === "comment_lot_number_or_bid" ||
          reason === "comment_number_bid")
      ) {
        if (trayLots.has(ev.lotNumber)) {
          const lot = trayLots.get(ev.lotNumber)!;
          if (!lot.closed && !lot.aldimClaim) {
            claimLot(lot, {
              buyer: buyerHint,
              offsetMs: ev.offsetMs,
              eventId: ev.id,
              amountTry: lotSaleAsk(lot) ?? ev.amountTry,
              matched: ev.matched,
              descriptorTokens: descTokens,
            });
            lot.bids.push({
              offsetMs: ev.offsetMs,
              amountTry: lotSaleAsk(lot),
              buyerHint: buyerHint,
              source: ev.source,
              reason: "numbered_lot_claim",
              eventId: ev.id,
            });
            continue;
          }
          if (lot.aldimClaim && lot.aldimClaim.buyer !== buyerHint) {
            const ask = lotSaleAsk(lot);
            pushNeedsReview({
              offsetMs: ev.offsetMs,
              amountTry: ask,
              buyerUsername: buyerHint,
              confidence: 0.5,
              reason: "numbered_lot_second_claim_needs_review",
              saleMethod: "aldim_first_comment",
              evidenceEventIds: [...lot.openEventIds, ev.id],
              productHint: lot.productHint ?? `${ev.lotNumber} numara`,
              askAmountTry: ask,
              evidenceQuote: ev.matched.slice(0, 200),
            });
            continue;
          }
        } else if (trayLots.size > 0) {
          // Tray is open but this digit does not match any slot.
          const near = nearestRecentAsk(ev.offsetMs);
          const openAsk =
            [...trayLots.values()]
              .map((l) => lotSaleAsk(l))
              .find((a) => a != null) ?? near?.amountTry;
          pushNeedsReview({
            offsetMs: ev.offsetMs,
            amountTry: openAsk,
            buyerUsername: buyerHint,
            confidence: 0.48,
            reason: "unmatched_lot_number_needs_review",
            saleMethod: "aldim_first_comment",
            evidenceEventIds: [ev.id],
            productHint: `${ev.lotNumber} numara (eşleşmedi)`,
            askAmountTry: openAsk,
            evidenceQuote: ev.matched.slice(0, 200),
          });
          continue;
        }
      }

      // «2000+2500=4500» / Nunus «800+800» — two sell legs for the same buyer.
      if (dualSum && buyerHint && ev.source === "comment") {
        const claimAsk = win && !win.closed ? lotSaleAsk(win) : undefined;
        const alreadyConfirmed = sales
          .filter(
            (s) =>
              !s.needsReview &&
              s.buyerUsername === buyerHint &&
              s.amountTry != null,
          )
          .map((s) => s.amountTry!);
        const aDone = alreadyConfirmed.some((x) => amountsNear(x, dualSum.a));
        const bDone = alreadyConfirmed.some((x) => amountsNear(x, dualSum.b));
        // Same-price dual («800+800»): two unit sales for the buyer.
        const samePrice = amountsNear(dualSum.a, dualSum.b);
        if (samePrice) {
          const unit = dualSum.a;
          const near = nearestRecentAsk(ev.offsetMs);
          const priced =
            (claimAsk != null && amountsNear(claimAsk, unit)
              ? claimAsk
              : undefined) ??
            (saneAsk(near?.amountTry) != null &&
            amountsNear(near!.amountTry, unit)
              ? near!.amountTry
              : undefined) ??
            unit;
          if (win && !win.closed && !win.aldimClaim) {
            claimLot(win, {
              buyer: buyerHint,
              offsetMs: ev.offsetMs,
              eventId: ev.id,
              amountTry: priced,
              matched: ev.matched,
            });
            emitAldimSale(win);
            win.closed = true;
            win = null;
            // Second same-price leg
            pushNeedsReview({
              offsetMs: ev.offsetMs + 1,
              amountTry: priced,
              buyerUsername: buyerHint,
              confidence: 0.72,
              reason: "dual_same_price_second_leg",
              saleMethod: "aldim_first_comment",
              evidenceEventIds: [ev.id],
              productHint: near?.hint ?? ev.matched.slice(0, 120),
              askAmountTry: priced,
              evidenceQuote: ev.matched.slice(0, 200),
            });
          } else if (!aDone && !bDone) {
            for (let leg = 0; leg < 2; leg++) {
              sales.push({
                offsetMs: ev.offsetMs + leg,
                amountTry: priced,
                buyerUsername: buyerHint,
                confidence: 0.8,
                reason: `dual_same_price_leg_${leg + 1}`,
                saleMethod: "aldim_first_comment",
                evidenceEventIds: [ev.id],
                productHint: near?.hint ?? ev.matched.slice(0, 120),
                askAmountTry: priced,
                evidenceQuote: ev.matched.slice(0, 200),
              });
            }
          } else if (aDone !== bDone) {
            pushNeedsReview({
              offsetMs: ev.offsetMs,
              amountTry: priced,
              buyerUsername: buyerHint,
              confidence: 0.56,
              reason: "dual_same_price_second_needs_review",
              saleMethod: "aldim_first_comment",
              evidenceEventIds: [ev.id],
              productHint: win?.productHint ?? ev.matched.slice(0, 120),
              askAmountTry: priced,
              evidenceQuote: ev.matched.slice(0, 200),
            });
          }
          pendingDualReview = null;
          continue;
        }
        // Prefer the sum leg that is NOT already a confirmed sale for this buyer.
        const pickSecond = (): number => {
          if (aDone && !bDone) return dualSum.b;
          if (bDone && !aDone) return dualSum.a;
          if (
            claimAsk != null &&
            amountsNear(dualSum.a, claimAsk) &&
            !amountsNear(dualSum.b, claimAsk)
          ) {
            return dualSum.b;
          }
          if (
            claimAsk != null &&
            amountsNear(dualSum.b, claimAsk) &&
            !amountsNear(dualSum.a, claimAsk)
          ) {
            return dualSum.a;
          }
          if (claimAsk != null && amountsNear(dualSum.b, claimAsk)) {
            return dualSum.b;
          }
          if (claimAsk != null && amountsNear(dualSum.a, claimAsk)) {
            return dualSum.a;
          }
          return dualSum.b;
        };
        const second = pickSecond();
        // First leg: claim open lot when ask matches either side.
        if (win && !win.closed && !win.aldimClaim && claimAsk != null) {
          if (
            amountsNear(claimAsk, dualSum.a) ||
            amountsNear(claimAsk, dualSum.b)
          ) {
            claimLot(win, {
              buyer: buyerHint,
              offsetMs: ev.offsetMs,
              eventId: ev.id,
              amountTry: claimAsk,
              matched: ev.matched,
            });
            emitAldimSale(win);
            win.closed = true;
            win = null;
          }
        }
        pushNeedsReview({
          offsetMs: ev.offsetMs,
          amountTry: second,
          buyerUsername: buyerHint,
          confidence: 0.56,
          reason: "dual_claim_sum_needs_review",
          saleMethod: "aldim_first_comment",
          evidenceEventIds: win
            ? [...win.openEventIds, ev.id]
            : [ev.id],
          productHint: win?.productHint ?? ev.matched.slice(0, 120),
          askAmountTry: second,
          evidenceQuote: ev.matched.slice(0, 200),
        });
        pendingDualReview = null;
        continue;
      }

      if (!win || win.closed) {
        // Try parked sequential intros (descriptor / amount match) before orphaning.
        if (isAldimClaim && buyerHint && ev.source === "comment") {
          const parked = findPendingMatch({
            offsetMs: ev.offsetMs,
            amountTry: saneAsk(ev.amountTry),
            descriptorTokens: descTokens,
          });
          if (parked) {
            claimLot(parked, {
              buyer: buyerHint,
              offsetMs: ev.offsetMs,
              eventId: ev.id,
              amountTry: saneAsk(ev.amountTry),
              matched: ev.matched,
              descriptorTokens: descTokens,
            });
            emitAldimSale(parked);
            parked.closed = true;
            if (dualAldim) {
              pendingDualReview = {
                buyer: buyerHint,
                offsetMs: ev.offsetMs,
                eventId: ev.id,
                matched: ev.matched,
              };
            }
            continue;
          }
          orphanClaims.push({
            buyer: buyerHint,
            offsetMs: ev.offsetMs,
            eventId: ev.id,
            amountTry: saneAsk(ev.amountTry) ?? ev.amountTry,
            matched: ev.matched,
            descriptorTokens: descTokens,
            lotNumber: ev.lotNumber,
          });
          if (dualAldim) {
            pendingDualReview = {
              buyer: buyerHint,
              offsetMs: ev.offsetMs,
              eventId: ev.id,
              matched: ev.matched,
            };
          }
        }
        continue;
      }
      if (isAldimClaim && buyerHint && ev.source === "comment") {
        // Prefer descriptor match against another parked lot when current win
        // is a poor fit (sequential A/B/C intros, claim arrives on B's window).
        const winDesc = win.descriptorTokens ??
          extractDescriptorTokens(win.productHint ?? "");
        const winAsk = lotSaleAsk(win);
        const descScore = descriptorOverlapScore(descTokens, winDesc);
        const amountFits =
          ev.amountTry == null ||
          winAsk == null ||
          ev.amountTry === winAsk ||
          amountsNear(ev.amountTry, winAsk);
        const preferParked =
          (descTokens.length > 0 && descScore < 1) ||
          (ev.amountTry != null && winAsk != null && !amountFits);
        if (preferParked) {
          const parked = findPendingMatch({
            offsetMs: ev.offsetMs,
            amountTry: saneAsk(ev.amountTry),
            descriptorTokens: descTokens,
          });
          if (parked && (descriptorOverlapScore(descTokens, parked.descriptorTokens) >= 1 ||
            (saneAsk(ev.amountTry) != null &&
              lotSaleAsk(parked) != null &&
              amountsNear(saneAsk(ev.amountTry)!, lotSaleAsk(parked)!)))) {
            claimLot(parked, {
              buyer: buyerHint,
              offsetMs: ev.offsetMs,
              eventId: ev.id,
              amountTry: saneAsk(ev.amountTry),
              matched: ev.matched,
              descriptorTokens: descTokens,
            });
            emitAldimSale(parked);
            parked.closed = true;
            continue;
          }
        }
        if (
          !win.aldimClaim &&
          ev.offsetMs - win.openMs <= ALDIM_CLAIM_WINDOW_MS
        ) {
          claimLot(win, {
            buyer: buyerHint,
            offsetMs: ev.offsetMs,
            eventId: ev.id,
            amountTry: saneAsk(ev.amountTry),
            matched: ev.matched,
            descriptorTokens: descTokens,
          });
          if (dualAldim) {
            win.dualClaimPending = {
              buyer: buyerHint,
              offsetMs: ev.offsetMs,
              eventId: ev.id,
              matched: ev.matched,
            };
            pendingDualReview = win.dualClaimPending;
          }
        } else if (
          win.aldimClaim &&
          win.aldimClaim.buyer !== buyerHint
        ) {
          // Second follower — try parked lot, else review + orphan for a near-future ask.
          const parked = findPendingMatch({
            offsetMs: ev.offsetMs,
            amountTry: saneAsk(ev.amountTry),
            descriptorTokens: descTokens,
          });
          if (parked) {
            claimLot(parked, {
              buyer: buyerHint,
              offsetMs: ev.offsetMs,
              eventId: ev.id,
              amountTry: saneAsk(ev.amountTry),
              matched: ev.matched,
              descriptorTokens: descTokens,
            });
            emitAldimSale(parked);
            parked.closed = true;
          } else {
            const ask = lotSaleAsk(win);
            const priced = saneAsk(ev.amountTry) ?? ask;
            pushNeedsReview({
              offsetMs: ev.offsetMs,
              amountTry: priced,
              buyerUsername: buyerHint,
              confidence: 0.54,
              reason: "second_claim_needs_review",
              saleMethod: "aldim_first_comment",
              evidenceEventIds: [...win.openEventIds, ev.id],
              productHint: win.productHint ?? ev.matched.slice(0, 120),
              askAmountTry: priced,
              evidenceQuote: ev.matched.slice(0, 200),
            });
            orphanClaims.push({
              buyer: buyerHint,
              offsetMs: ev.offsetMs,
              eventId: ev.id,
              amountTry: saneAsk(ev.amountTry) ?? ev.amountTry,
              matched: ev.matched,
              descriptorTokens: descTokens,
              lotNumber: ev.lotNumber,
            });
          }
        } else if (
          win.aldimClaim &&
          win.aldimClaim.buyer === buyerHint &&
          dualAldim
        ) {
          // Same buyer «ikisini de aldım» after first claim → second item review.
          win.dualClaimPending = {
            buyer: buyerHint,
            offsetMs: ev.offsetMs,
            eventId: ev.id,
            matched: ev.matched,
          };
          pendingDualReview = win.dualClaimPending;
        }
      }
      // Reject non-claim chatter that only looked like aldım («gec kaldim»).
      const meaningfulBid =
        ev.amountTry != null ||
        (isAldimClaim && buyerHint) ||
        (buyerHint &&
          reason !== "aldim_claim" &&
          reason !== "descriptor_aldim_claim");
      if (meaningfulBid && (buyerHint || ev.amountTry != null)) {
        win.bids.push({
          offsetMs: ev.offsetMs,
          amountTry: ev.amountTry,
          buyerHint: buyerHint,
          source: ev.source,
          reason: ev.reason,
          eventId: ev.id,
        });
      }
      continue;
    }

    if (ev.eventType === "sold") {
      // Seller flower emoji closes the open lot (pey escalate or aldım claim).
      if (reason === "seller_flower_end") {
        const openWin = win && !win.closed ? win : null;
        if (openWin) {
          if (emitAldimSale(openWin)) {
            openWin.closed = true;
            win = null;
          } else {
            parkUnclaimedLot(openWin, ev.offsetMs);
            win = null;
          }
        }
        continue;
      }

      // Nunus: «1 numara Gamze hanım» closes that tray number (first claim or verbal).
      if (
        reason === "numbered_lot_verbal_confirm" &&
        ev.lotNumber != null &&
        trayLots.has(ev.lotNumber)
      ) {
        const lot = trayLots.get(ev.lotNumber)!;
        const lotAsk = lotSaleAsk(lot);
        const amount = lotAsk ?? ev.amountTry;
        const evidence = [...lot.openEventIds, ev.id];
        let buyer = ev.buyerHint;
        if (!buyer && ev.spokenBuyerName) {
          const pool: BidContext[] = [
            ...lot.bids,
            ...(lot.aldimClaim
              ? [
                  {
                    offsetMs: lot.aldimClaim.offsetMs,
                    buyerHint: lot.aldimClaim.buyer,
                    source: "comment" as const,
                    eventId: lot.aldimClaim.eventId,
                  },
                ]
              : []),
          ];
          buyer = matchSpokenNameToBuyer(ev.spokenBuyerName, pool) ?? undefined;
        }
        if (lot.aldimClaim && !buyer) {
          buyer = lot.aldimClaim.buyer;
        }
        if (buyer && amount != null) {
          sales.push({
            offsetMs: ev.offsetMs,
            amountTry: amount,
            buyerUsername: buyer,
            spokenBuyerName: ev.spokenBuyerName,
            confidence: 0.9,
            reason: "numbered_lot_verbal_confirm",
            saleMethod: "verbal_win_confirm",
            evidenceEventIds: [...new Set(evidence)],
            productHint: lot.productHint ?? `${ev.lotNumber} numara`,
            askAmountTry: lot.openingAskTry ?? amount,
            evidenceQuote: ev.matched.slice(0, 200),
          });
          lot.namedMissReview = undefined;
          lot.closed = true;
          trayLots.delete(ev.lotNumber);
          if (win === lot) win = null;
          continue;
        }
        if (ev.spokenBuyerName) {
          lot.namedMissReview = {
            offsetMs: ev.offsetMs,
            spokenBuyerName: ev.spokenBuyerName,
            amountTry: amount,
            evidenceEventIds: evidence,
            evidenceQuote: ev.matched.slice(0, 200),
            productHint: lot.productHint,
            reason: "numbered_lot_verbal_confirm+named_unmatched_needs_review",
          };
          continue;
        }
      }

      // Correlate with open window
      let buyer = isSellerBuyer(ev.buyerHint) ? undefined : ev.buyerHint;
      let amount = ev.amountTry;
      const isVerbal =
        reason.includes("verbal_win") ||
        reason === "numbered_lot_verbal_confirm" ||
        isVerbalWinPhrase(ev.matched);
      let method: SaleMethod = reason.includes("counter_accept")
        ? "counter_accept"
        : isVerbal
          ? "verbal_win_confirm"
          : "sold_phrase";
      const evidence = [ev.id];
      const openWin = win && !win.closed ? win : null;
      /** Named verbal confirm that did not match any commenter handle. */
      let verbalNameMiss = false;
      const lotAsk = openWin ? lotSaleAsk(openWin) : undefined;

      if (openWin) {
        evidence.push(...openWin.openEventIds);
        if (lotAsk != null && amount == null) {
          amount = lotAsk;
        }

        // Counter-accept: take latest counter bid amount + buyer
        if (method === "counter_accept" || reason.includes("counter_accept")) {
          const counters = openWin.bids.filter(
            (b) =>
              b.reason === "counter_offer" ||
              (b.amountTry != null &&
                b.buyerHint &&
                !isSellerBuyer(b.buyerHint)),
          );
          const last = counters[counters.length - 1];
          if (last) {
            if (last.buyerHint) buyer = buyer ?? last.buyerHint;
            if (last.amountTry != null) amount = last.amountTry;
            if (last.eventId) evidence.push(last.eventId);
            method = "counter_accept";
          }
        }

        // Verbal win: match spoken name → lot bids, then recent commenters (Nunus «hanımda»).
        if (!buyer && isVerbal && ev.spokenBuyerName) {
          const pool: Array<{ buyerHint?: string; displayName?: string }> = [];
          if (openWin.aldimClaim) {
            pool.push({ buyerHint: openWin.aldimClaim.buyer });
          }
          for (const b of openWin.bids) {
            pool.push({
              buyerHint: b.buyerHint,
              displayName: b.displayName,
            });
          }
          for (const c of recentCommenters) {
            if (ev.offsetMs - c.offsetMs > SALE_BID_LOOKBACK_MS * 2) continue;
            if (c.offsetMs > ev.offsetMs + 5_000) continue;
            pool.push({ buyerHint: c.buyerHint });
          }
          for (const o of orphanClaims) {
            if (Math.abs(ev.offsetMs - o.offsetMs) > SALE_BID_LOOKBACK_MS * 2)
              continue;
            pool.push({ buyerHint: o.buyer });
          }
          const hits = matchSpokenNameHits(ev.spokenBuyerName, pool);
          if (hits.length === 1) {
            buyer = hits[0]!;
            method = "verbal_win_confirm";
            for (const b of openWin.bids) {
              if (b.eventId && b.buyerHint === buyer) evidence.push(b.eventId);
            }
            if (openWin.aldimClaim?.buyer === buyer) {
              evidence.push(openWin.aldimClaim.eventId);
            }
            // Name confirm without prior aldım still freezes the ask (Nunus packing).
            if (!openWin.aldimClaim) {
              claimLot(openWin, {
                buyer,
                offsetMs: ev.offsetMs,
                eventId: ev.id,
                amountTry: amount ?? lotAsk,
                matched: ev.matched,
              });
            }
          } else if (hits.length > 1) {
            // Near-miss: multiple handles match the spoken name → operator picks.
            pushNeedsReview({
              offsetMs: ev.offsetMs,
              amountTry: amount ?? lotAsk,
              buyerUsername: hits[0],
              spokenBuyerName: ev.spokenBuyerName,
              confidence: 0.56,
              reason: "verbal_win_ambiguous_buyer_needs_review",
              saleMethod: "verbal_win_confirm",
              evidenceEventIds: [...new Set(evidence)],
              productHint: openWin.productHint ?? ev.matched.slice(0, 120),
              askAmountTry: lotAsk ?? amount,
              evidenceQuote: `${ev.matched.slice(0, 120)} (aday: ${hits.slice(0, 3).join(", ")})`,
            });
            continue;
          } else {
            // Named confirm that doesn't match any commenter → prefer unknown
            // (do not invent / do not steal a different aldım claimer).
            verbalNameMiss = true;
          }
        }

        // Pey escalate on seller confirm: highest bid above ask beats first aldım.
        if (!buyer && !verbalNameMiss && openWin) {
          const pey = pickHighestPeyBid(openWin);
          if (pey) {
            buyer = pey.buyer;
            amount = pey.amountTry;
            if (pey.eventId) evidence.push(pey.eventId);
            if (openWin.aldimClaim) evidence.push(openWin.aldimClaim.eventId);
            method = isVerbal ? "verbal_win_confirm" : "bid_win_confirm";
          }
        }

        // Aldım claim + seller later confirms (incl. bare «hayırlı olsun»)
        // Prefer the frozen claimer over later chat bids (glam: «ikisi de sizin»
        // must not steal @iyiymis via @gnshsgl arithmetic chatter) — unless pey
        // already escalated above.
        if (
          !buyer &&
          !verbalNameMiss &&
          openWin.aldimClaim &&
          !isSellerBuyer(openWin.aldimClaim.buyer)
        ) {
          buyer = openWin.aldimClaim.buyer;
          amount = amount ?? lotAsk;
          evidence.push(openWin.aldimClaim.eventId);
          method = isVerbal ? "verbal_win_confirm" : "aldim_first_comment";
        }

        // Nunus soft «sizde» / «gitti» with no name: attach the most recent
        // ask-price or aldım commenter in the lookback (single best guess).
        if (!buyer && !verbalNameMiss && isVerbal && openWin) {
          const ask = lotAsk;
          const window = recentCommenters.filter(
            (c) =>
              ev.offsetMs - c.offsetMs >= 0 &&
              ev.offsetMs - c.offsetMs <= 90_000,
          );
          const priceMatch =
            ask != null
              ? [...window]
                  .reverse()
                  .find(
                    (c) =>
                      c.amountTry != null &&
                      (c.amountTry === ask || amountsNear(c.amountTry, ask)),
                  )
              : undefined;
          const orphanMatch = [...orphanClaims]
            .reverse()
            .find(
              (o) =>
                ev.offsetMs - o.offsetMs >= 0 &&
                ev.offsetMs - o.offsetMs <= 90_000,
            );
          const pick =
            priceMatch ??
            (orphanMatch
              ? {
                  buyerHint: orphanMatch.buyer,
                  eventId: orphanMatch.eventId,
                  amountTry: orphanMatch.amountTry,
                }
              : undefined) ??
            (window.length === 1 ? window[0] : undefined);
          if (pick?.buyerHint) {
            buyer = pick.buyerHint;
            amount = amount ?? ask ?? pick.amountTry;
            if (pick.eventId) evidence.push(pick.eventId);
            method = "verbal_win_confirm";
            if (!openWin.aldimClaim) {
              claimLot(openWin, {
                buyer,
                offsetMs: ev.offsetMs,
                eventId: ev.id,
                amountTry: amount,
                matched: ev.matched,
              });
            }
          }
        }

        // Win confirm after bids (classic satıldı / lookback) — only if no aldım claim
        if (!buyer && !verbalNameMiss && openWin.bids.length) {
          const enriched = enrichSoldFromBids(
            {
              eventType: "sold",
              confidence: ev.confidence,
              matched: ev.matched,
              amountTry: amount,
              buyerHint: buyer,
              reason: ev.reason,
            },
            openWin.bids,
            ev.offsetMs,
          );
          buyer = enriched.buyerHint;
          if (buyer) {
            method = isVerbal ? "verbal_win_confirm" : "bid_win_confirm";
          }
          for (const b of openWin.bids) {
            if (b.eventId && b.buyerHint === buyer) evidence.push(b.eventId);
          }
        }

        // Pin sold price to lot ask unless counter-accept explicitly took a lower bid
        amount = resolveSaleAmountTry({
          askTry: lotAsk,
          eventAmountTry: amount,
          method,
        });
      }

      // Gate: need buyer comment OR @ on confirmation; price preferred
      const hasBuyer = Boolean(buyer);
      const hasPrice = amount != null;
      // Follower chatter «satıldı» without ask/price is not a sale (prefer unknown).
      if (!hasPrice && method === "sold_phrase") {
        if (openWin && !isVerbal) {
          openWin.closed = true;
          win = null;
        }
        continue;
      }
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
      const worthSale =
        isSaleWorthy(pseudo) && hasBuyer && (hasPrice || method !== "sold_phrase");

      if (worthSale) {
        if (openWin) {
          openWin.closed = true;
          win = null;
        }
        pushSaleUnits(
          {
            offsetMs: ev.offsetMs,
            amountTry: amount,
            buyerUsername: buyer,
            spokenBuyerName: ev.spokenBuyerName,
            confidence,
            reason: `${reason || "sold"}+${method}`,
            saleMethod: method,
            evidenceEventIds: [...new Set(evidence)],
            productHint: ev.productHint ?? ev.matched.slice(0, 120),
            askAmountTry: lotAsk ?? amount,
            evidenceQuote: ev.matched.slice(0, 200),
          },
          ev.quantity,
        );
        continue;
      }

      // Named verbal («İris / Sevda hayırlı olsun») with no handle match →
      // stash on the open lot; emit needs_review only if lot ends without a sale.
      // Do not steal / close over an unrelated aldım — and do not invent @handle.
      if (isVerbal && verbalNameMiss && ev.spokenBuyerName && openWin) {
        openWin.namedMissReview = {
          offsetMs: ev.offsetMs,
          spokenBuyerName: ev.spokenBuyerName,
          amountTry: amount ?? lotAsk,
          evidenceEventIds: [...new Set(evidence)],
          evidenceQuote: ev.matched.slice(0, 200),
          productHint: ev.productHint ?? ev.matched.slice(0, 120),
          reason: `${reason || "verbal_win"}+named_unmatched_needs_review`,
        };
        continue;
      }

      // Weak verbal (bare hayırlı / named with no matchable handle) on an open
      // ask — surface for review with price filled rather than silent drop.
      if (isVerbal && openWin && (lotAsk != null || amount != null)) {
        pushNeedsReview({
          offsetMs: ev.offsetMs,
          amountTry: amount ?? lotAsk,
          buyerUsername: buyer,
          spokenBuyerName: ev.spokenBuyerName,
          confidence: 0.5,
          reason: ev.spokenBuyerName
            ? "weak_verbal_named_needs_review"
            : "weak_verbal_bare_needs_review",
          saleMethod: "verbal_win_confirm",
          evidenceEventIds: [...new Set(evidence)],
          productHint: openWin.productHint ?? ev.matched.slice(0, 120),
          askAmountTry: lotAsk ?? amount,
          evidenceQuote: ev.matched.slice(0, 200),
        });
        continue;
      }

      // Named verbal with no open lot — match recent commenters; confirm when
      // price is known («Deniz hanımda 800»), else needs_review.
      if (isVerbal && ev.spokenBuyerName && !openWin) {
        const spokenFold = foldTrToken(ev.spokenBuyerName);
        const near = nearestRecentAsk(ev.offsetMs);
        const priced = amount ?? near?.amountTry;
        // Same buyer packing another (different) price is a new sale —
        // only skip when amount is missing or near the prior confirm.
        const qty = ev.quantity != null && ev.quantity >= 2 ? ev.quantity : 1;
        const alreadyConfirmed = sales.some((s) => {
          if (s.needsReview) return false;
          if (Math.abs(s.offsetMs - ev.offsetMs) > SALE_DEDUP_WINDOW_MS)
            return false;
          const samePerson =
            (s.spokenBuyerName &&
              foldTrToken(s.spokenBuyerName) === spokenFold) ||
            (s.buyerUsername != null &&
              foldTrToken(s.buyerUsername).includes(spokenFold));
          if (!samePerson) return false;
          // «4 tane 600» after a prior single 600 is additional inventory.
          if (qty >= 2) return false;
          if (priced == null || s.amountTry == null) return true;
          return amountsNear(s.amountTry, priced);
        });
        if (alreadyConfirmed) continue;
        const pool = recentCommenters
          .filter(
            (c) =>
              ev.offsetMs - c.offsetMs <= SALE_BID_LOOKBACK_MS * 2 &&
              c.offsetMs <= ev.offsetMs + 5_000,
          )
          .map((c) => ({ buyerHint: c.buyerHint }));
        for (const o of orphanClaims) {
          if (Math.abs(ev.offsetMs - o.offsetMs) <= SALE_BID_LOOKBACK_MS * 2) {
            pool.push({ buyerHint: o.buyer });
          }
        }
        // Wider commenter pool for packing confirms (Nunus names lag comments).
        const widePool = recentCommenters
          .filter(
            (c) =>
              ev.offsetMs - c.offsetMs <= SALE_BID_LOOKBACK_MS * 4 &&
              c.offsetMs <= ev.offsetMs + 10_000,
          )
          .map((c) => ({ buyerHint: c.buyerHint }));
        for (const o of orphanClaims) {
          if (Math.abs(ev.offsetMs - o.offsetMs) <= SALE_BID_LOOKBACK_MS * 4) {
            widePool.push({ buyerHint: o.buyer });
          }
        }
        const hits = matchSpokenNameHits(ev.spokenBuyerName, [
          ...pool,
          ...widePool,
        ]);
        if (hits.length === 1 && priced != null && saneAsk(priced) != null) {
          pushSaleUnits(
            {
              offsetMs: ev.offsetMs,
              amountTry: amount ?? priced,
              buyerUsername: hits[0],
              spokenBuyerName: ev.spokenBuyerName,
              confidence: 0.86,
              reason: "verbal_hanimda_no_lot+name_match",
              saleMethod: "verbal_win_confirm",
              evidenceEventIds: [ev.id],
              productHint: near?.hint ?? ev.matched.slice(0, 120),
              askAmountTry: amount ?? priced,
              evidenceQuote: ev.matched.slice(0, 200),
            },
            ev.quantity,
          );
          continue;
        }
        // Always surface named packing for review with price — never silent drop.
        const reviewPrice =
          saneAsk(amount) ?? priced ?? nearestRecentAsk(ev.offsetMs)?.amountTry;
        if (reviewPrice != null || hits.length > 0) {
          pushSaleUnits(
            {
              offsetMs: ev.offsetMs,
              amountTry: reviewPrice,
              buyerUsername: hits.length === 1 ? hits[0] : hits[0],
              spokenBuyerName: ev.spokenBuyerName,
              confidence: 0.5,
              reason:
                hits.length > 1
                  ? "verbal_win_no_lot_ambiguous_needs_review"
                  : hits.length === 1
                    ? "verbal_win_no_lot_needs_review"
                    : "verbal_win_named_unmatched_needs_review",
              saleMethod: "verbal_win_confirm",
              evidenceEventIds: [ev.id],
              productHint: near?.hint ?? ev.matched.slice(0, 120),
              askAmountTry: reviewPrice,
              evidenceQuote: ev.matched.slice(0, 200),
            },
            ev.quantity,
            { needsReview: true },
          );
        }
        continue;
      }

      // Bare soft packing («O da sizde» / «İkisi de tamam») with no open lot —
      // attach recent ask-price commenter (Nunus multi-item bursts).
      if (isVerbal && !ev.spokenBuyerName && !openWin) {
        const near = nearestRecentAsk(ev.offsetMs);
        const ask = amount ?? near?.amountTry;
        if (ask != null && saneAsk(ask) != null) {
          const window = recentCommenters.filter(
            (c) =>
              ev.offsetMs - c.offsetMs >= 0 &&
              ev.offsetMs - c.offsetMs <= 90_000,
          );
          const priceMatch = [...window]
            .reverse()
            .find(
              (c) =>
                c.amountTry != null &&
                (c.amountTry === ask || amountsNear(c.amountTry, ask)),
            );
          const orphanMatch = [...orphanClaims]
            .reverse()
            .find(
              (o) =>
                ev.offsetMs - o.offsetMs >= 0 &&
                ev.offsetMs - o.offsetMs <= 90_000,
            );
          const pick =
            priceMatch ??
            (orphanMatch
              ? {
                  buyerHint: orphanMatch.buyer,
                  eventId: orphanMatch.eventId,
                  amountTry: orphanMatch.amountTry,
                }
              : undefined);
          if (pick?.buyerHint) {
            const already = sales.some(
              (s) =>
                !s.needsReview &&
                s.buyerUsername === pick.buyerHint &&
                s.amountTry != null &&
                amountsNear(s.amountTry, ask) &&
                Math.abs(s.offsetMs - ev.offsetMs) <= SALE_DEDUP_WINDOW_MS,
            );
            // «İkisi de» / second «sizde» after first confirm → allow a second
            // same-price sale outside the tight dedup only when dual phrasing.
            const dualPhrase = VERBAL_WIN_IKISI_DE_RE.test(ev.matched);
            if (!already || dualPhrase) {
              if (already && dualPhrase) {
                pushNeedsReview({
                  offsetMs: ev.offsetMs,
                  amountTry: ask,
                  buyerUsername: pick.buyerHint,
                  confidence: 0.55,
                  reason: "dual_soft_sizde_second_needs_review",
                  saleMethod: "verbal_win_confirm",
                  evidenceEventIds: [ev.id, pick.eventId].filter(
                    Boolean,
                  ) as string[],
                  productHint: near?.hint ?? ev.matched.slice(0, 120),
                  askAmountTry: ask,
                  evidenceQuote: ev.matched.slice(0, 200),
                });
              } else if (!already) {
                sales.push({
                  offsetMs: ev.offsetMs,
                  amountTry: ask,
                  buyerUsername: pick.buyerHint,
                  confidence: 0.82,
                  reason: "soft_sizde_no_lot+price_commenter",
                  saleMethod: "verbal_win_confirm",
                  evidenceEventIds: [ev.id, pick.eventId].filter(
                    Boolean,
                  ) as string[],
                  productHint: near?.hint ?? ev.matched.slice(0, 120),
                  askAmountTry: ask,
                  evidenceQuote: ev.matched.slice(0, 200),
                });
              }
            }
          }
        }
        continue;
      }

      // Unmatched bare verbal with no open lot: ignore
      // (repeat hayırlı after close must not invent extra needs_review rows).
      if (isVerbal) continue;

      // Classic sold without buyer evidence: close lot, skip sale
      // (do not invent needs_review from «lazım olur» / counter chatter).
      if (openWin) {
        flushNamedMissIfPending();
        openWin.closed = true;
        win = null;
      }
    }
  }

  // End of timeline: complete open aldım claim / tray / parked lots
  flushAldimIfClaimed(Number.MAX_SAFE_INTEGER);
  flushTrayLots(Number.MAX_SAFE_INTEGER);
  for (const p of pendingUnclaimed) {
    if (p.aldimClaim) emitAldimSale(p);
    else emitNamedMiss(p);
  }
  pendingUnclaimed = [];

  // Remaining orphan aldım (never attached to an ask) → needs_review.
  // Prefer operator review over silent drop (glam/afra: mid-live orphans
  // used to vanish when they sat before the last ask).
  // Fill ask/sold amount from the comment when known («Aldım 800»).
  for (const o of orphanClaims) {
    const already = sales.some(
      (s) =>
        s.buyerUsername === o.buyer &&
        Math.abs(s.offsetMs - o.offsetMs) <= SALE_DEDUP_WINDOW_MS,
    );
    if (already) continue;
    // Last chance: amount/descriptor against any leftover parked lot.
    const parked = findPendingMatch({
      offsetMs: o.offsetMs,
      amountTry: saneAsk(o.amountTry),
      descriptorTokens: o.descriptorTokens,
    });
    if (parked) {
      claimLot(parked, {
        buyer: o.buyer,
        offsetMs: o.offsetMs,
        eventId: o.eventId,
        amountTry: saneAsk(o.amountTry),
        matched: o.matched,
        descriptorTokens: o.descriptorTokens,
      });
      emitAldimSale(parked);
      continue;
    }
    const near = nearestRecentAsk(o.offsetMs);
    const priced = saneAsk(o.amountTry) ?? near?.amountTry;
    pushNeedsReview({
      offsetMs: o.offsetMs,
      amountTry: priced,
      buyerUsername: o.buyer,
      confidence: priced != null ? 0.55 : 0.5,
      reason:
        saneAsk(o.amountTry) != null
          ? "orphan_aldim_with_price_needs_review"
          : near != null
            ? "orphan_aldim_nearest_ask_needs_review"
            : "orphan_aldim_no_ask_needs_review",
      saleMethod: "aldim_first_comment",
      evidenceEventIds: [o.eventId],
      productHint:
        o.matched?.slice(0, 120) ??
        near?.hint ??
        `Yorum aldım @ ${o.offsetMs}ms (ask yok)`,
      askAmountTry: priced,
      evidenceQuote:
        o.matched?.slice(0, 200) ??
        `@${o.buyer} aldım (ask penceresi yok)`,
    });
  }

  // «İkisini de» never got a second ask → still surface for operator.
  if (pendingDualReview) {
    const d = pendingDualReview;
    const already = sales.some(
      (s) =>
        s.needsReview &&
        s.buyerUsername === d.buyer &&
        Math.abs(s.offsetMs - d.offsetMs) <= SALE_DEDUP_WINDOW_MS,
    );
    if (!already) {
      pushNeedsReview({
        offsetMs: d.offsetMs,
        amountTry: d.secondAmountTry,
        buyerUsername: d.buyer,
        confidence: 0.52,
        reason: "dual_claim_unresolved_needs_review",
        saleMethod: "aldim_first_comment",
        evidenceEventIds: [d.eventId],
        productHint: d.matched.slice(0, 120),
        askAmountTry: d.secondAmountTry,
        evidenceQuote: d.matched.slice(0, 200),
      });
    }
  }

  // Hard rule: never leave seller / brand-sibling as buyerUsername.
  const scrubbed = sales.flatMap((s) => {
    if (!isSellerBuyer(s.buyerUsername)) return [s];
    // Drop confident auto-sales; keep priced needs_review without seller buyer.
    if (!s.needsReview && s.confidence >= 0.78) return [];
    return [
      {
        ...s,
        buyerUsername: undefined,
        needsReview: true,
        confidence: Math.min(s.confidence, 0.5),
        reason: `${s.reason}+seller_buyer_stripped`,
      },
    ];
  });
  return dedupeSaleCandidates(scrubbed);
}

function isPricedAskEvent(ev: TimelineEvent): boolean {
  if (ev.eventType !== "price_mention" && ev.eventType !== "item_intro") {
    return false;
  }
  return (
    ev.amountTry != null &&
    Number.isFinite(ev.amountTry) &&
    ev.amountTry >= OFFER_AMOUNT_SANITY_MIN_TRY &&
    ev.amountTry <= OFFER_AMOUNT_SANITY_MAX_TRY
  );
}

/**
 * Bare «1800 lira.» crumbs must not split lots.
 * Product-cue lines («bunlar da 1000 lira», «fiyatı 3500», «bu elimdeki 2400»,
 * «uzunlar 1000», «bu da 2500», ASR «kolyo ucu») may open the next lot.
 */
function isLotOpeningPriceLine(text: string): boolean {
  return (
    /fiyat|set(?:i|imiz)?|a[cç][ıi]l[ıi][sş]|ald[ıi]m\s+diyene|bunun|bunlar(?:\s+da)?|k[uü]pe|kolye|kolyo|bro[sş]|bilezik|bileklik|y[uü]z[uü]k|cam\s+kolye|\bmezat\b|ile\s+mezat|elimdeki|elimde\b|uzunlar|k[ıi]salar|u[cç]umuz|\bu[cç]u(?:muz)?\b|\bmone[t]?\b|trifari|\bbu\s+da\b|\bnumara\b|diyelim|olsun/i.test(
      text,
    ) || PRODUCT_NOUN_RE.test(text)
  );
}

/** «İkisini de aldım» — buyer claims a second item; do not auto-confirm the pair. */
export function isDualAldimClaimText(text: string): boolean {
  // foldTr: JS /i does not map Turkish İ→i («İkisini» would miss).
  return /iki(?:sini|si)?\s+de\s+aldim/i.test(foldTrToken(text));
}

/**
 * Comment arithmetic «2000+ 2500 = 4500» → two lot asks (second often needs_review).
 */
export function parseDualClaimSum(text: string): { a: number; b: number; sum: number } | undefined {
  const withEq = text.match(
    /(\d{3,5})\s*\+\s*(\d{3,5})\s*=\s*(\d{3,6})/,
  );
  if (withEq?.[1] && withEq[2] && withEq[3]) {
    const a = Number(withEq[1]);
    const b = Number(withEq[2]);
    const sum = Number(withEq[3]);
    if ([a, b, sum].every((n) => Number.isFinite(n) && n >= OFFER_AMOUNT_SANITY_MIN_TRY)) {
      return { a, b, sum };
    }
  }
  // Nunus chat: bare «800+800» / «800 + 800» (no equals) = two same-price takes.
  const bare = text.match(/^\s*(\d{3,5})\s*\+\s*(\d{3,5})\s*$/);
  if (bare?.[1] && bare[2]) {
    const a = Number(bare[1]);
    const b = Number(bare[2]);
    if (
      Number.isFinite(a) &&
      Number.isFinite(b) &&
      a >= OFFER_AMOUNT_SANITY_MIN_TRY &&
      b >= OFFER_AMOUNT_SANITY_MIN_TRY
    ) {
      return { a, b, sum: a + b };
    }
  }
  return undefined;
}

/** Floor so double-ASR of the same utterance does not split a lot. */
const LOT_PRODUCT_CUE_MIN_MS = 15_000;

/** True when a priced ask should start a new product lot (not a re-show / revise). */
function shouldOpenNewProductLot(opts: {
  matched: string;
  amount: number;
  openingAsk: number;
  lastAsk: number;
  dtOpen: number;
  strong: boolean;
}): boolean {
  const exact =
    opts.amount === opts.openingAsk || opts.amount === opts.lastAsk;
  const nearOpening = amountsNear(opts.amount, opts.openingAsk);
  const nearLast = amountsNear(opts.amount, opts.lastAsk);
  const productCue = isLotOpeningPriceLine(opts.matched);
  // Product-cued ask → new lot after settle, even at the *same* TRY
  // (Nunus: many distinct «bu da 800» items). Different TRY still splits
  // inside the early window (glam «bu elimdeki 2400» after 2200).
  if (productCue && opts.dtOpen >= LOT_PRODUCT_CUE_MIN_MS) {
    if (!exact) return true;
    // Same ask + product cue («bu da 800» again) = next product, not pan.
    if (/\bbu\s+da\b|\bbunlar(?:\s+da)?\b|\bnumara\b|elimdeki|elimde\b/i.test(opts.matched)) {
      return true;
    }
  }
  if (opts.dtOpen < LOT_MIN_NEW_MS) return false;
  if ((opts.strong || productCue) && !nearOpening && !nearLast) return true;
  // Bare but clearly different ask after settle → new lot (glam «2000 TL'ymiş»
  // after a 2500 window). Prefer under-merge of distinct products.
  if (!exact && !nearOpening && !nearLast) return true;
  return false;
}

/**
 * Sparse product-centric lots from a timeline.
 *
 * One lot = one product window from first ask until pass/sold or a clear new ask.
 * Repeated restatements / camera re-shows of the same ask merge into one lot.
 * Opening ask is counted once (pey / counters / repeats do not add to the sum).
 */
export function buildProductLots(events: TimelineEvent[]): ProductLot[] {
  const sorted = [...events].sort((a, b) => a.offsetMs - b.offsetMs);
  const lots: ProductLot[] = [];
  let lot: {
    openMs: number;
    lastMs: number;
    openingAskTry: number;
    lastAskTry: number;
    eventIds: string[];
    productHint?: string;
  } | null = null;

  const closeLot = (atMs: number) => {
    if (!lot) return;
    lots.push({
      openMs: lot.openMs,
      closeMs: Math.max(atMs, lot.lastMs),
      openingAskTry: lot.openingAskTry,
      eventIds: [...lot.eventIds],
      productHint: lot.productHint,
    });
    lot = null;
  };

  for (const ev of sorted) {
    if (ev.eventType === "pass" || ev.eventType === "sold") {
      closeLot(ev.offsetMs);
      continue;
    }
    if (!isPricedAskEvent(ev)) continue;
    const amt = ev.amountTry!;
    const reason = ev.reason ?? "";
    const strong =
      reason === "seller_aldim_ask" ||
      reason === "acilisim_ask" ||
      reason === "price_mention" ||
      reason === "numbered_lot_ask";

    if (!lot) {
      lot = {
        openMs: ev.offsetMs,
        lastMs: ev.offsetMs,
        openingAskTry: amt,
        lastAskTry: amt,
        eventIds: [ev.id],
        productHint: ev.productHint ?? ev.matched.slice(0, 120),
      };
      continue;
    }

    // Numbered tray siblings are always distinct lots (even same TRY / same second).
    if (ev.lotNumber != null && reason === "numbered_lot_ask") {
      closeLot(ev.offsetMs);
      lot = {
        openMs: ev.offsetMs,
        lastMs: ev.offsetMs,
        openingAskTry: amt,
        lastAskTry: amt,
        eventIds: [ev.id],
        productHint: ev.productHint ?? `${ev.lotNumber} numara`,
      };
      continue;
    }

    const dtLast = ev.offsetMs - lot.lastMs;
    const dtOpen = ev.offsetMs - lot.openMs;
    const nearOpening = amountsNear(amt, lot.openingAskTry);
    const nearLast = amountsNear(amt, lot.lastAskTry);
    const exactAsk =
      amt === lot.openingAskTry || amt === lot.lastAskTry;
    const productCue = isLotOpeningPriceLine(ev.matched);

    // Product-cued different TRY → new lot (even within ±20% / early window)
    if (
      shouldOpenNewProductLot({
        matched: ev.matched,
        amount: amt,
        openingAsk: lot.openingAskTry,
        lastAsk: lot.lastAskTry,
        dtOpen,
        strong:
          strong ||
          (reason === "seller_price_line" && productCue),
      })
    ) {
      closeLot(ev.offsetMs);
      lot = {
        openMs: ev.offsetMs,
        lastMs: ev.offsetMs,
        openingAskTry: amt,
        lastAskTry: amt,
        eventIds: [ev.id],
        productHint: ev.productHint ?? ev.matched.slice(0, 120),
      };
      continue;
    }

    // Re-show / restatement of same or near ask (bare crumbs / camera pan)
    if ((nearOpening || nearLast || exactAsk) && dtLast <= LOT_RESHOW_MERGE_MS) {
      lot.lastMs = ev.offsetMs;
      lot.lastAskTry = amt;
      lot.eventIds.push(ev.id);
      continue;
    }

    // Early revise on same product — keep opening ask (first announcement).
    // Never revise opening *down* (kısa companion «700» after «Uzunlar 1000»,
    // or etiket crumbs under a 4000 ask).
    if (dtOpen <= LOT_EARLY_REVISE_MS && !productCue) {
      lot.lastMs = ev.offsetMs;
      lot.lastAskTry = amt;
      lot.eventIds.push(ev.id);
      if (!nearOpening && dtLast <= 20_000 && amt >= lot.openingAskTry) {
        lot.openingAskTry = amt;
      }
      continue;
    }

    // Prefer under-merge of phantoms only for bare ambiguous chatter
    lot.lastMs = ev.offsetMs;
    lot.lastAskTry = amt;
    lot.eventIds.push(ev.id);
  }

  closeLot(Number.MAX_SAFE_INTEGER);
  return lots;
}

/**
 * KPI: distinct product lots (not every price utterance).
 * totalAskTry / offeredSumTry = sum of each lot’s opening ask only.
 */
export function summarizeOfferWindows(events: TimelineEvent[]): {
  productsOffered: number;
  offeredSumTry: number;
  lots: ProductLot[];
} {
  const lots = buildProductLots(events);
  let offeredSumTry = 0;
  for (const lot of lots) {
    if (
      Number.isFinite(lot.openingAskTry) &&
      lot.openingAskTry >= OFFER_AMOUNT_SANITY_MIN_TRY &&
      lot.openingAskTry <= OFFER_AMOUNT_SANITY_MAX_TRY
    ) {
      offeredSumTry += lot.openingAskTry;
    }
  }
  return {
    productsOffered: lots.length,
    offeredSumTry,
    lots,
  };
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
