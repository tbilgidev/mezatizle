import { describe, expect, test } from "bun:test";
import {
  assertSafeRelativePath,
  enrichSoldFromBids,
  explainSaleTr,
  isAuctionNoise,
  isSaleWorthy,
  isSellerAcceptPhrase,
  isVerbalWinPhrase,
  matchSpokenNameToBuyer,
  normalizeInstagramUsername,
  parseAuctionText,
  parseAuctionTexts,
  parseBuyerHint,
  parsePriceTry,
  parseSpokenBuyerName,
  parseTurkishWordAmount,
  reconcileMezatWindows,
  buildProductLots,
  summarizeOfferWindows,
  resolveProfile,
  SALE_MIN_CONFIDENCE,
  type TimelineEvent,
} from "@mezatizle/shared";

describe("shared validation", () => {
  test("normalizes instagram username", () => {
    expect(normalizeInstagramUsername("@Demo_Shop")).toBe("demo_shop");
  });

  test("rejects bad username", () => {
    expect(() => normalizeInstagramUsername("bad user")).toThrow();
  });

  test("blocks path traversal", () => {
    expect(() => assertSafeRelativePath("../etc/passwd")).toThrow();
    expect(() => assertSafeRelativePath("/abs")).toThrow();
    expect(assertSafeRelativePath("recordings/a.mp4")).toBe("recordings/a.mp4");
  });

  test("LOCAL profile disables paid APIs", () => {
    const p = resolveProfile("LOCAL", { PROCESSING_PROFILE: "LOCAL" });
    expect(p.allowPaidApis).toBe(false);
    expect(p.hardSpendLimitUsd).toBe(0);
  });
});

describe("Turkish auction rules", () => {
  test("sold with @buyer + currency is high confidence", () => {
    const s = parseAuctionText("Satıldı @mehmet_demo 700 TL");
    expect(s?.eventType).toBe("sold");
    expect(s?.buyerHint).toBe("mehmet_demo");
    expect(s?.amountTry).toBe(700);
    expect(s!.confidence).toBeGreaterThanOrEqual(0.9);
    expect(isSaleWorthy(s!)).toBe(true);
  });

  test("comment aldım is bid never sold", () => {
    const s = parseAuctionText("aldım 500 TL", { source: "comment" });
    expect(s?.eventType).toBe("bid");
    expect(s?.amountTry).toBe(500);
    expect(parseAuctionText("aldım TL", { source: "comment" })?.eventType).toBe(
      "bid",
    );
  });

  test("co-host Aldım X dir / açılışımız are asks not buyer claims", () => {
    const ask = parseAuctionText("Aldım 50.000₺ dir✅✅✅", {
      source: "comment",
    });
    expect(ask?.eventType).toBe("price_mention");
    expect(ask?.reason).toBe("seller_aldim_ask");
    expect(ask?.amountTry).toBe(50000);

    const acilis = parseAuctionText(
      "Açılışımız 5.000₺ peylerimiz 1.000₺ katlarıdır✅✅",
      { source: "comment" },
    );
    expect(acilis?.eventType).toBe("price_mention");
    expect(acilis?.reason).toBe("acilisim_ask");
    expect(acilis?.amountTry).toBe(5000);

    const diyene = parseAuctionText("Aldım diyene 60.000 TL'dir", {
      source: "transcript",
    });
    expect(diyene?.eventType).toBe("price_mention");
    expect(diyene?.amountTry).toBe(60000);
  });

  test("lazım olur / yine olur / tamam için are not counter_accept", () => {
    expect(
      parseAuctionText("Eser abi bu lazım olur.", { source: "transcript" }),
    ).toBeNull();
    expect(
      parseAuctionText("Diğer mezat da yine olur ikilliler.", {
        source: "transcript",
      }),
    ).toBeNull();
    expect(
      parseAuctionText("Tamam için.", { source: "transcript" }),
    ).toBeNull();
    const ok = parseAuctionText("tamam olur", { source: "transcript" });
    expect(ok?.eventType).toBe("sold");
    expect(ok?.reason).toMatch(/counter_accept/);
  });

  test("aldım diyene N scales to bin when bare", () => {
    const s = parseAuctionText("Bu da ilk aldım diyene 11.", {
      source: "transcript",
    });
    expect(s?.eventType).toBe("price_mention");
    expect(s?.amountTry).toBe(11000);
  });

  test("comment number bids scale low digits to bin", () => {
    const nine = parseAuctionText("9", { source: "comment" });
    expect(nine?.eventType).toBe("bid");
    expect(nine?.amountTry).toBe(9000);
    expect(nine?.reason).toBe("comment_number_bid");
    expect(parseAuctionText("10", { source: "comment" })?.amountTry).toBe(
      10000,
    );
  });

  test("seller transcript aldım + bin/lira is ASK not sold", () => {
    const s = parseAuctionText("Fincanı aldım on bin lira", {
      source: "transcript",
    });
    expect(s?.eventType).toBe("price_mention");
    expect(s?.reason).toBe("seller_aldim_ask");
    expect(s?.amountTry).toBe(10000);
    expect(isSaleWorthy({ eventType: s!.eventType, confidence: s!.confidence })).toBe(
      false,
    );

    const s2 = parseAuctionText("Bu da aldım 8 bin lira", {
      source: "transcript",
    });
    expect(s2?.eventType).toBe("price_mention");
    expect(s2?.amountTry).toBe(8000);
  });

  test("Turkish number words and N bin", () => {
    expect(parsePriceTry("on bin lira")).toBe(10000);
    expect(parsePriceTry("altı bin")).toBe(6000);
    expect(parsePriceTry("üç bin beş yüz")).toBe(3500);
    expect(parsePriceTry("25 bin")).toBe(25000);
    expect(parseTurkishWordAmount("Iki bin beş yüz lira")).toBe(2500);
  });

  test("spoken buyer name is not buyer_username", () => {
    const s = parseAuctionText("Satıldı Mehmet 700 TL");
    expect(s?.buyerHint).toBeUndefined();
    expect(parseSpokenBuyerName("Satıldı Mehmet 700 TL")).toBe("Mehmet");
    expect(s?.spokenBuyerName).toBe("Mehmet");
  });

  test("plain +50 / arttır are bids", () => {
    expect(parseAuctionText("+50")?.eventType).toBe("bid");
    expect(parseAuctionText("arttırıyorum 650")?.eventType).toBe("bid");
  });

  test("spoken name without @ is not buyer", () => {
    const s = parseAuctionText("Satıldı Mehmet 700 TL");
    expect(s?.eventType).toBe("sold");
    expect(s?.buyerHint).toBeUndefined();
    expect(s?.amountTry).toBe(700);
    // price without @buyer is below sale gate now (prefer unknown)
    expect(isSaleWorthy(s!)).toBe(false);
  });

  test("satılmadı / iptal / düzeltme are pass not sold", () => {
    expect(parseAuctionText("bu ürün satılmadı")?.eventType).toBe("pass");
    expect(parseAuctionText("iptal ettik @x 200 TL")?.eventType).toBe("pass");
    expect(parseAuctionText("düzeltme yanlış söyledim")?.eventType).toBe(
      "pass",
    );
  });

  test("unsold kalıyor is pass", () => {
    expect(parseAuctionText("kalıyor bir sonraki")?.eventType).toBe("pass");
  });

  test("price formats 1.500 and 1500₺", () => {
    expect(parsePriceTry("1.500 TL")).toBe(1500);
    expect(parsePriceTry("açılış 300₺")).toBe(300);
    expect(parseBuyerHint("tebrikler @ayse_demo")).toBe("ayse_demo");
  });

  test("sold phrase only is below sale gate", () => {
    const s = parseAuctionText("satıldı");
    expect(s?.eventType).toBe("sold");
    expect(s!.confidence).toBeLessThan(SALE_MIN_CONFIDENCE);
    expect(isSaleWorthy(s!)).toBe(false);
  });

  test("OCR noise ignored", () => {
    expect(parseAuctionText("###")).toBeNull();
    expect(isAuctionNoise("@@@!!!")).toBe(true);
  });

  test("enrich sold from nearby OCR bid @", () => {
    const sold = parseAuctionText("Satıldı 700 TL")!;
    expect(sold.buyerHint).toBeUndefined();
    const next = enrichSoldFromBids(
      sold,
      [
        {
          offsetMs: 1000,
          amountTry: 700,
          buyerHint: "mehmet_demo",
          source: "comment",
        },
      ],
      5000,
    );
    expect(next.buyerHint).toBe("mehmet_demo");
    expect(next.confidence).toBeGreaterThan(sold.confidence);
  });

  test("explainSaleTr prefers unknown over inventing", () => {
    const t = explainSaleTr({
      confidence: 0.82,
      reason: "sold+price+currency",
      buyer: null,
      amountCents: 70000,
      gaps: ["buyer_unknown"],
    });
    expect(t).toContain("Alıcı bilinmiyor");
    expect(t).toContain("needs_review");
  });

  test("item intro and price mention", () => {
    expect(
      parseAuctionText("Sıradaki ürün: lacivert ceket, açılış 500 TL")
        ?.eventType,
    ).toBe("item_intro");
    expect(
      parseAuctionText("minimum fiyat 200 TL")?.eventType,
    ).toBe("price_mention");
  });

  test("Whisper Türk lirası counts as currency; multi-sold splits", () => {
    const many = parseAuctionTexts(
      "Satıldı Mehmet 700 Türk lirası, yeni ürün, kırmızı çanta, açılış 300 Türk lirası, satıldı Ayşe 450 Türk lirası.",
    );
    const solds = many.filter((s) => s.eventType === "sold");
    expect(solds.length).toBeGreaterThanOrEqual(2);
    expect(solds.some((s) => s.amountTry === 700)).toBe(true);
    expect(solds.some((s) => s.amountTry === 450)).toBe(true);
    expect(solds.every((s) => !s.buyerHint)).toBe(true);
  });
});

describe("mezat window reconcile", () => {
  const ev = (
    partial: Partial<TimelineEvent> &
      Pick<TimelineEvent, "id" | "offsetMs" | "eventType" | "matched">,
  ): TimelineEvent => ({
    source: "transcript",
    confidence: 0.8,
    ...partial,
  });

  test("seller ask alone creates no sale", () => {
    const sales = reconcileMezatWindows([
      ev({
        id: "1",
        offsetMs: 1000,
        eventType: "price_mention",
        matched: "Fincanı aldım on bin lira",
        amountTry: 10000,
        reason: "seller_aldim_ask",
      }),
      ev({
        id: "2",
        offsetMs: 20000,
        eventType: "price_mention",
        matched: "Bu aldım üç bin",
        amountTry: 3000,
        reason: "seller_aldim_ask",
      }),
    ]);
    expect(sales.length).toBe(0);
  });

  test("co-host ask comment then lazım-olur chatter creates no sale", () => {
    const sales = reconcileMezatWindows([
      ev({
        id: "ask",
        offsetMs: 147660,
        eventType: "price_mention",
        matched: "Aldım 60.000₺ dir",
        amountTry: 60000,
        reason: "seller_aldim_ask",
        source: "comment",
      }),
      ev({
        id: "chatter",
        offsetMs: 250520,
        eventType: "sold",
        matched: "Eser abi bu lazım olur.",
        reason: "counter_accept",
        confidence: 0.55,
      }),
    ]);
    // No buyer evidence — prefer unknown
    expect(sales.length).toBe(0);
  });

  test("first follower aldım comment wins at ask price", () => {
    const sales = reconcileMezatWindows([
      ev({
        id: "ask",
        offsetMs: 1000,
        eventType: "price_mention",
        matched: "aldım 20000 lira",
        amountTry: 20000,
        reason: "seller_aldim_ask",
      }),
      ev({
        id: "c1",
        offsetMs: 3000,
        eventType: "bid",
        matched: "aldım",
        buyerHint: "ayse_demo",
        reason: "aldim_claim",
        source: "comment",
        confidence: 0.6,
      }),
      ev({
        id: "c2",
        offsetMs: 5000,
        eventType: "bid",
        matched: "aldım",
        buyerHint: "late_bidder",
        reason: "aldim_claim",
        source: "comment",
        confidence: 0.6,
      }),
      ev({
        id: "next",
        offsetMs: 30000,
        eventType: "price_mention",
        matched: "aldım 5000 lira",
        amountTry: 5000,
        reason: "seller_aldim_ask",
      }),
    ]);
    expect(sales.length).toBe(1);
    expect(sales[0]!.buyerUsername).toBe("ayse_demo");
    expect(sales[0]!.amountTry).toBe(20000);
    expect(sales[0]!.saleMethod).toBe("aldim_first_comment");
  });

  test("late follower aldım (minutes after ask) still claims open lot", () => {
    const sales = reconcileMezatWindows([
      ev({
        id: "ask",
        offsetMs: 0,
        eventType: "price_mention",
        matched: "aldım 4500 lira",
        amountTry: 4500,
        reason: "seller_aldim_ask",
      }),
      ev({
        id: "c1",
        offsetMs: 5 * 60_000,
        eventType: "bid",
        matched: "Aldim",
        buyerHint: "z.g.sahsuvaroglu",
        reason: "aldim_claim",
        source: "comment",
        confidence: 0.6,
      }),
      ev({
        id: "next",
        offsetMs: 6 * 60_000,
        eventType: "price_mention",
        matched: "sıradaki 3000",
        amountTry: 3000,
        reason: "seller_aldim_ask",
      }),
    ]);
    expect(sales.length).toBe(1);
    expect(sales[0]!.buyerUsername).toBe("z.g.sahsuvaroglu");
    expect(sales[0]!.amountTry).toBe(4500);
    expect(sales[0]!.saleMethod).toBe("aldim_first_comment");
  });

  test("bid then seller confirm correlates OCR buyer", () => {
    const sales = reconcileMezatWindows([
      ev({
        id: "ask",
        offsetMs: 0,
        eventType: "price_mention",
        matched: "açılış 1000 TL",
        amountTry: 1000,
        reason: "price_mention",
      }),
      ev({
        id: "b1",
        offsetMs: 2000,
        eventType: "bid",
        matched: "1200",
        amountTry: 1200,
        buyerHint: "mehmet_demo",
        source: "comment",
        reason: "bid_phrase",
      }),
      ev({
        id: "win",
        offsetMs: 8000,
        eventType: "sold",
        matched: "satıldı 1200 TL",
        amountTry: 1200,
        reason: "sold+price+currency_no_buyer",
        confidence: 0.72,
      }),
    ]);
    expect(sales.length).toBe(1);
    expect(sales[0]!.buyerUsername).toBe("mehmet_demo");
    expect(sales[0]!.amountTry).toBe(1200);
    expect(sales[0]!.saleMethod).toBe("bid_win_confirm");
  });

  test("counter-offer accept uses buyer amount", () => {
    const sales = reconcileMezatWindows([
      ev({
        id: "ask",
        offsetMs: 0,
        eventType: "price_mention",
        matched: "aldım 20000 lira",
        amountTry: 20000,
        reason: "seller_aldim_ask",
      }),
      ev({
        id: "c",
        offsetMs: 4000,
        eventType: "bid",
        matched: "18 veririm",
        amountTry: 18000,
        buyerHint: "canan_v",
        source: "comment",
        reason: "counter_offer",
      }),
      ev({
        id: "ok",
        offsetMs: 7000,
        eventType: "sold",
        matched: "tamam olur",
        reason: "counter_accept",
        confidence: 0.68,
      }),
    ]);
    expect(sales.length).toBe(1);
    expect(sales[0]!.buyerUsername).toBe("canan_v");
    expect(sales[0]!.amountTry).toBe(18000);
    expect(sales[0]!.saleMethod).toBe("counter_accept");
  });

  test("unsold pass yields no sale", () => {
    const sales = reconcileMezatWindows([
      ev({
        id: "ask",
        offsetMs: 0,
        eventType: "price_mention",
        matched: "aldım 5000 lira",
        amountTry: 5000,
        reason: "seller_aldim_ask",
      }),
      ev({
        id: "pass",
        offsetMs: 10000,
        eventType: "pass",
        matched: "satılmadı kalıyor",
        reason: "unsold_or_pass",
      }),
    ]);
    expect(sales.length).toBe(0);
  });

  test("sold without buyer evidence is not materialized", () => {
    const sales = reconcileMezatWindows([
      ev({
        id: "win",
        offsetMs: 1000,
        eventType: "sold",
        matched: "satıldı 700 TL",
        amountTry: 700,
        reason: "sold+price+currency_no_buyer",
        confidence: 0.82,
      }),
    ]);
    expect(sales.length).toBe(0);
  });

  test("verbal win «X hanım sizindir» matches recent aldım username", () => {
    const sales = reconcileMezatWindows([
      ev({
        id: "ask",
        offsetMs: 0,
        eventType: "price_mention",
        matched: "aldım 3500 lira",
        amountTry: 3500,
        reason: "seller_aldim_ask",
      }),
      ev({
        id: "c1",
        offsetMs: 4000,
        eventType: "bid",
        matched: "aldım",
        buyerHint: "ayse.vintage42",
        reason: "aldim_claim",
        source: "comment",
        confidence: 0.6,
      }),
      ev({
        id: "vw",
        offsetMs: 12000,
        eventType: "sold",
        matched: "Ayşe hanım sizindir",
        spokenBuyerName: "Ayşe",
        reason: "verbal_win_named",
        confidence: 0.8,
      }),
    ]);
    expect(sales.length).toBe(1);
    expect(sales[0]!.buyerUsername).toBe("ayse.vintage42");
    expect(sales[0]!.amountTry).toBe(3500);
    expect(sales[0]!.saleMethod).toBe("verbal_win_confirm");
  });

  test("repeated verbal confirms yield one sale per lot", () => {
    const sales = reconcileMezatWindows([
      ev({
        id: "ask",
        offsetMs: 0,
        eventType: "price_mention",
        matched: "aldım 5000 lira",
        amountTry: 5000,
        reason: "seller_aldim_ask",
      }),
      ev({
        id: "c1",
        offsetMs: 3000,
        eventType: "bid",
        matched: "aldım",
        buyerHint: "mehmet_demo",
        reason: "aldim_claim",
        source: "comment",
        confidence: 0.6,
      }),
      ev({
        id: "vw1",
        offsetMs: 10000,
        eventType: "sold",
        matched: "Mehmet bey sizde",
        spokenBuyerName: "Mehmet",
        reason: "verbal_win_named",
        confidence: 0.8,
      }),
      ev({
        id: "vw2",
        offsetMs: 14000,
        eventType: "sold",
        matched: "Mehmet bey sizindir",
        spokenBuyerName: "Mehmet",
        reason: "verbal_win_named",
        confidence: 0.8,
      }),
      ev({
        id: "vw3",
        offsetMs: 20000,
        eventType: "sold",
        matched: "bravo Mehmet hayırlı olsun",
        spokenBuyerName: "Mehmet",
        reason: "verbal_win_named",
        confidence: 0.8,
      }),
    ]);
    expect(sales.length).toBe(1);
    expect(sales[0]!.buyerUsername).toBe("mehmet_demo");
    expect(sales[0]!.amountTry).toBe(5000);
    expect(sales[0]!.saleMethod).toBe("verbal_win_confirm");
  });

  test("unmatched spoken name → needs_review (no invented @handle)", () => {
    const sales = reconcileMezatWindows([
      ev({
        id: "ask",
        offsetMs: 0,
        eventType: "price_mention",
        matched: "aldım 2000 lira",
        amountTry: 2000,
        reason: "seller_aldim_ask",
      }),
      ev({
        id: "vw",
        offsetMs: 8000,
        eventType: "sold",
        matched: "Sevda hanımcığım hayırlı olsun",
        spokenBuyerName: "Sevda",
        reason: "verbal_win_named",
        confidence: 0.8,
      }),
    ]);
    // No commenter matches «Sevda» — persist needs_review (not silent drop).
    expect(sales.length).toBe(1);
    expect(sales[0]!.buyerUsername).toBeUndefined();
    expect(sales[0]!.spokenBuyerName).toBe("Sevda");
    expect(sales[0]!.needsReview).toBe(true);
    expect(sales[0]!.amountTry).toBe(2000);
    expect(sales[0]!.saleMethod).toBe("verbal_win_confirm");
  });

  test("named miss then aldım claim prefers the comment sale (not double)", () => {
    const sales = reconcileMezatWindows([
      ev({
        id: "ask",
        offsetMs: 0,
        eventType: "price_mention",
        matched: "aldım 2000 lira",
        amountTry: 2000,
        reason: "seller_aldim_ask",
      }),
      ev({
        id: "vw",
        offsetMs: 5000,
        eventType: "sold",
        matched: "İris de sizin hayırlı olsun",
        spokenBuyerName: "İris",
        reason: "verbal_win_named",
        confidence: 0.8,
      }),
      ev({
        id: "c1",
        offsetMs: 8000,
        eventType: "bid",
        matched: "aldım",
        buyerHint: "z.g.sahsuvaroglu",
        reason: "aldim_claim",
        source: "comment",
        confidence: 0.6,
      }),
    ]);
    // Later aldım claims the lot → one auto sale; named miss dropped (not double).
    expect(sales.length).toBe(1);
    expect(sales[0]!.buyerUsername).toBe("z.g.sahsuvaroglu");
    expect(sales[0]!.needsReview).toBeUndefined();
  });

  test("bare hayırlı olsun confirms open aldım claim once", () => {
    const sales = reconcileMezatWindows([
      ev({
        id: "ask",
        offsetMs: 0,
        eventType: "price_mention",
        matched: "aldım 4200 lira",
        amountTry: 4200,
        reason: "seller_aldim_ask",
      }),
      ev({
        id: "c1",
        offsetMs: 5000,
        eventType: "bid",
        matched: "aldım",
        buyerHint: "halecaloglu1",
        reason: "aldim_claim",
        source: "comment",
        confidence: 0.6,
      }),
      ev({
        id: "vw1",
        offsetMs: 15000,
        eventType: "sold",
        matched: "Hayırlı olsun",
        reason: "verbal_win_bare",
        confidence: 0.62,
      }),
      ev({
        id: "vw2",
        offsetMs: 18000,
        eventType: "sold",
        matched: "Hayırlı olsun güle güle kullan",
        reason: "verbal_win_bare",
        confidence: 0.62,
      }),
    ]);
    expect(sales.length).toBe(1);
    expect(sales[0]!.buyerUsername).toBe("halecaloglu1");
    expect(sales[0]!.amountTry).toBe(4200);
    expect(sales[0]!.saleMethod).toBe("verbal_win_confirm");
  });

  test("correction pass carries aldım to restated ask + güle güle confirm", () => {
    const sales = reconcileMezatWindows([
      ev({
        id: "ask1",
        offsetMs: 0,
        eventType: "price_mention",
        matched: "Bunların fiyatı 5 bin lira.",
        amountTry: 5000,
        reason: "price_mention",
      }),
      ev({
        id: "vw_name",
        offsetMs: 20_000,
        eventType: "sold",
        matched: "Şeyhna zavallıdan bir aldım geldi.",
        spokenBuyerName: "Şeyhna",
        reason: "verbal_win_named",
        confidence: 0.8,
      }),
      ev({
        id: "c1",
        offsetMs: 40_000,
        eventType: "bid",
        matched: "Aldım hazırdı",
        buyerHint: "sehnazsenerergun",
        reason: "aldim_claim",
        source: "comment",
        confidence: 0.6,
      }),
      ev({
        id: "pass",
        offsetMs: 50_000,
        eventType: "pass",
        matched: "Tamam senin yanlış oldu.",
        reason: "correction_or_void",
      }),
      ev({
        id: "ask2",
        offsetMs: 60_000,
        eventType: "price_mention",
        matched: "Fiyatı dediğim gibi 5 bin lira.",
        amountTry: 5000,
        reason: "price_mention",
      }),
      ev({
        id: "vw_gule",
        offsetMs: 90_000,
        eventType: "sold",
        matched: "Güle güle takın hepsini.",
        reason: "verbal_win_bare",
        confidence: 0.62,
      }),
    ]);
    expect(sales.length).toBe(1);
    expect(sales[0]!.buyerUsername).toBe("sehnazsenerergun");
    expect(sales[0]!.amountTry).toBe(5000);
    expect(sales[0]!.saleMethod).toBe("verbal_win_confirm");
  });

  test("orphan aldım shortly before ask still claims the lot", () => {
    const sales = reconcileMezatWindows([
      ev({
        id: "c1",
        offsetMs: 1000,
        eventType: "bid",
        matched: "Aldım",
        buyerHint: "draylingunbay",
        reason: "aldim_claim",
        source: "comment",
        confidence: 0.6,
      }),
      ev({
        id: "ask",
        offsetMs: 1500,
        eventType: "price_mention",
        matched: "Bunlar da 1000 lira.",
        amountTry: 1000,
        reason: "price_mention",
      }),
      ev({
        id: "ask2",
        offsetMs: 80_000,
        eventType: "price_mention",
        matched: "Bunun da fiyatı 6000 lira.",
        amountTry: 6000,
        reason: "price_mention",
      }),
    ]);
    expect(sales.length).toBe(1);
    expect(sales[0]!.buyerUsername).toBe("draylingunbay");
    expect(sales[0]!.amountTry).toBe(1000);
    expect(sales[0]!.saleMethod).toBe("aldim_first_comment");
  });

  test("second aldım on open lot orphans onto the next ask", () => {
    const sales = reconcileMezatWindows([
      ev({
        id: "ask1",
        offsetMs: 0,
        eventType: "price_mention",
        matched: "3.000 liraydı bunun fiyatı.",
        amountTry: 3000,
        reason: "price_mention",
      }),
      ev({
        id: "c1",
        offsetMs: 10_000,
        eventType: "bid",
        matched: "Aldim",
        buyerHint: "z.g.sahsuvaroglu",
        reason: "aldim_claim",
        source: "comment",
        confidence: 0.6,
      }),
      ev({
        id: "c2",
        offsetMs: 40_000,
        eventType: "bid",
        matched: "Aldım",
        buyerHint: "draylingunbay",
        reason: "aldim_claim",
        source: "comment",
        confidence: 0.6,
      }),
      ev({
        id: "ask2",
        offsetMs: 41_000,
        eventType: "price_mention",
        matched: "Bunlar da 1000 lira.",
        amountTry: 1000,
        reason: "price_mention",
      }),
      ev({
        id: "ask3",
        offsetMs: 120_000,
        eventType: "price_mention",
        matched: "Bunun da fiyatı 6000 lira.",
        amountTry: 6000,
        reason: "price_mention",
      }),
    ]);
    expect(sales.length).toBe(2);
    expect(sales.map((s) => [s.buyerUsername, s.amountTry])).toEqual([
      ["z.g.sahsuvaroglu", 3000],
      ["draylingunbay", 1000],
    ]);
  });

  test("pey number comment + bare hayırlı olsun confirms sale", () => {
    const sales = reconcileMezatWindows([
      ev({
        id: "ask",
        offsetMs: 0,
        eventType: "price_mention",
        matched: "Bunun fiyatı da 4000 lira.",
        amountTry: 4000,
        reason: "price_mention",
      }),
      ev({
        id: "pey",
        offsetMs: 3000,
        eventType: "bid",
        matched: "4000",
        amountTry: 4000,
        buyerHint: "claudia_sadioglu",
        reason: "comment_number_bid",
        source: "comment",
        confidence: 0.62,
      }),
      ev({
        id: "c1",
        offsetMs: 5000,
        eventType: "bid",
        matched: "aldim",
        buyerHint: "claudia_sadioglu",
        reason: "aldim_claim",
        source: "comment",
        confidence: 0.6,
      }),
      ev({
        id: "vw",
        offsetMs: 12000,
        eventType: "sold",
        matched: "hayırlı olsun",
        reason: "verbal_win_bare",
        confidence: 0.62,
      }),
    ]);
    expect(sales.length).toBe(1);
    expect(sales[0]!.buyerUsername).toBe("claudia_sadioglu");
    expect(sales[0]!.amountTry).toBe(4000);
    expect(sales[0]!.saleMethod).toBe("verbal_win_confirm");
  });
});

describe("verbal win phrase parse", () => {
  test("detects Turkish win phrases and spoken names", () => {
    expect(isVerbalWinPhrase("Ayşe hanım sizindir")).toBe(true);
    expect(isVerbalWinPhrase("Mehmet bey sizde")).toBe(true);
    expect(isVerbalWinPhrase("Zeynep abla sizindir")).toBe(true);
    expect(isVerbalWinPhrase("sizde kaldı")).toBe(true);
    expect(isVerbalWinPhrase("hayırlı olsun")).toBe(true);
    expect(isVerbalWinPhrase("bravo Ayşe")).toBe(true);
    expect(isVerbalWinPhrase("Ergi Hanım sizin bir saniye")).toBe(false);
    expect(isVerbalWinPhrase("Hayırlı olsun diyeceğim.")).toBe(false);
    expect(isVerbalWinPhrase("Güle güle kullan değişik.")).toBe(false);
    expect(isVerbalWinPhrase("Güle güle kullan.")).toBe(true);
    expect(parsePriceTry("Bu üç bin dört yüz üç bin sekiz yüz")).toBe(3400);

    expect(parseSpokenBuyerName("Ayşe hanım sizindir")).toBe("Ayşe");
    expect(parseSpokenBuyerName("Mehmet bey sizde")).toBe("Mehmet");
    expect(parseSpokenBuyerName("Hayırlı olsun sevda hanımcığım")).toBe(
      "sevda",
    );
    expect(parseSpokenBuyerName("Zeynep'e hayırlı olsun")).toBe("Zeynep");

    const named = parseAuctionText("Ayşe hanım sizindir", {
      source: "transcript",
    });
    expect(named?.eventType).toBe("sold");
    expect(named?.reason).toBe("verbal_win_named");
    expect(named?.spokenBuyerName).toBe("Ayşe");

    const bare = parseAuctionText("Hayırlı olsun güle güle kullan", {
      source: "transcript",
    });
    expect(bare?.eventType).toBe("sold");
    expect(bare?.reason).toBe("verbal_win_bare");
  });

  test("matchSpokenNameToBuyer is unique-or-unknown", () => {
    expect(
      matchSpokenNameToBuyer("Ayşe", [
        { buyerHint: "ayse.vintage42" },
        { buyerHint: "mehmet_demo" },
      ]),
    ).toBe("ayse.vintage42");
    expect(
      matchSpokenNameToBuyer("Sevda", [
        { buyerHint: "z.g.sahsuvaroglu" },
      ]),
    ).toBeUndefined();
    expect(
      matchSpokenNameToBuyer("Ayşe", [
        { buyerHint: "ayse_one" },
        { buyerHint: "ayse_two" },
      ]),
    ).toBeUndefined();
    expect(
      matchSpokenNameToBuyer("Hale", [
        { buyerHint: "halecaloglu1", displayName: "Hale Ç" },
      ]),
    ).toBe("halecaloglu1");
  });

  test("ASR typo Şeyhna matches @sehnaz… username prefix", () => {
    expect(
      matchSpokenNameToBuyer("Şeyhna", [
        { buyerHint: "sehnazsenerergun" },
      ]),
    ).toBe("sehnazsenerergun");
  });

  test("güle güle takın hepsini + aldım geldi are verbal wins", () => {
    expect(isVerbalWinPhrase("Güle güle takın hepsini.")).toBe(true);
    expect(isVerbalWinPhrase("Güle güle kullan değişik.")).toBe(false);
    expect(isVerbalWinPhrase("Şeyhna zavallıdan bir aldım geldi.")).toBe(
      true,
    );
    expect(
      parseSpokenBuyerName("Şeyhna zavallıdan bir aldım geldi."),
    ).toBe("Şeyhna");
    const g = parseAuctionText("Güle güle takın hepsini.", {
      source: "transcript",
    });
    expect(g?.eventType).toBe("sold");
    expect(g?.reason).toBe("verbal_win_bare");
  });

  test("question aldım does not claim; dotted thousands + no mutlaka-TL", () => {
    expect(
      parseAuctionText("Acaba senden mi aldım ?", { source: "comment" }),
    ).toBeNull();
    expect(parsePriceTry("Bunlar da satış fiyatımız 3.500 lira.")).toBe(
      3500,
    );
    expect(
      parsePriceTry("Yani neredeyse 18-20 bin liradan başlıyor."),
    ).toBeUndefined();
    expect(
      parseAuctionText("Bunlar da fiyatlar 300 poundan.", {
        source: "transcript",
      }),
    ).toBeNull();
    expect(
      isSellerAcceptPhrase("Tamam tek sıra gelirim ya mutlaka."),
    ).toBe(false);
    expect(
      parseAuctionText("satildi mi", { source: "comment" }),
    ).toBeNull();
    expect(
      parseAuctionText("satıldı mı?", { source: "transcript" }),
    ).toBeNull();
  });
});

describe("product lot dedup (sparse offers)", () => {
  const ev = (
    partial: Partial<TimelineEvent> &
      Pick<TimelineEvent, "id" | "offsetMs" | "eventType" | "matched">,
  ): TimelineEvent => ({
    source: "transcript",
    confidence: 0.8,
    ...partial,
  });

  test("repeated same ask (camera re-show) is one lot, opening ask once", () => {
    const events: TimelineEvent[] = [];
    for (let i = 0; i < 20; i++) {
      events.push(
        ev({
          id: `p${i}`,
          offsetMs: 10_000 + i * 10_000,
          eventType: "price_mention",
          matched: "7 bin lira ile mezat olsun.",
          amountTry: 7000,
          reason: "seller_price_line",
        }),
      );
    }
    const s = summarizeOfferWindows(events);
    expect(s.productsOffered).toBe(1);
    expect(s.offeredSumTry).toBe(7000);
  });

  test("pey / counters do not inflate totalAskTry", () => {
    const s = summarizeOfferWindows([
      ev({
        id: "ask",
        offsetMs: 0,
        eventType: "price_mention",
        matched: "Aldım 10000 lira",
        amountTry: 10000,
        reason: "seller_aldim_ask",
      }),
      ev({
        id: "bid1",
        offsetMs: 5000,
        eventType: "bid",
        matched: "11000",
        amountTry: 11000,
        reason: "bid_phrase",
        buyerHint: "ali",
      }),
      ev({
        id: "bid2",
        offsetMs: 8000,
        eventType: "bid",
        matched: "12000 veririm",
        amountTry: 12000,
        reason: "counter_offer",
        buyerHint: "veli",
      }),
      ev({
        id: "ask2",
        offsetMs: 200_000,
        eventType: "price_mention",
        matched: "Aldım 5000 lira",
        amountTry: 5000,
        reason: "seller_aldim_ask",
      }),
    ]);
    expect(s.productsOffered).toBe(2);
    expect(s.offeredSumTry).toBe(15_000);
  });

  test("pass closes lot; next ask is a new product", () => {
    const lots = buildProductLots([
      ev({
        id: "a1",
        offsetMs: 0,
        eventType: "price_mention",
        matched: "5 bin lira ile mezat olsun",
        amountTry: 5000,
        reason: "seller_price_line",
      }),
      ev({
        id: "pass",
        offsetMs: 60_000,
        eventType: "pass",
        matched: "geçiyoruz",
        reason: "unsold_or_pass",
      }),
      ev({
        id: "a2",
        offsetMs: 70_000,
        eventType: "price_mention",
        matched: "3 bin lira ile mezat olsun",
        amountTry: 3000,
        reason: "seller_price_line",
      }),
    ]);
    expect(lots.length).toBe(2);
    expect(lots[0]!.openingAskTry).toBe(5000);
    expect(lots[1]!.openingAskTry).toBe(3000);
  });

  test("prefers under-count vs 124 phantoms on dense restatements", () => {
    const events: TimelineEvent[] = [];
    // ~17 min of 10s-spaced restatements across 3 distinct asks
    let t = 0;
    for (let i = 0; i < 100; i++) {
      const amt = i < 40 ? 7000 : i < 70 ? 3000 : 12000;
      events.push(
        ev({
          id: `x${i}`,
          offsetMs: t,
          eventType: "price_mention",
          matched: `${amt} lira ile mezat olsun`,
          amountTry: amt,
          reason: i % 15 === 0 ? "seller_aldim_ask" : "seller_price_line",
        }),
      );
      t += 10_000;
    }
    const s = summarizeOfferWindows(events);
    // 100 utterances → ~3 lots (not 100); under-count OK
    expect(s.productsOffered).toBeLessThanOrEqual(6);
    expect(s.productsOffered).toBeGreaterThanOrEqual(2);
    expect(s.offeredSumTry).toBe(7000 + 3000 + 12000);
  });
});

describe("fixture gold labels (rules precision/recall)", () => {
  const lines = [
    { text: "Sıradaki ürün: lacivert ceket, açılış 500 TL", want: "item_intro" },
    { text: "@ayse_demo 600", want: "bid" },
    { text: "@mehmet_demo 700", want: "bid" },
    { text: "Satıldı @mehmet_demo 700 TL", want: "sold" },
    { text: "Yeni ürün: kırmızı çanta, açılış 300 TL", want: "item_intro" },
    { text: "@ayse_demo 450", want: "bid" },
    { text: "Satıldı @ayse_demo 450 TL", want: "sold" },
    { text: "aldım 400", want: "bid" },
    { text: "satılmadı kalıyor", want: "pass" },
    { text: "satıldı", want: "sold" },
  ];

  test("event-type accuracy on gold lines", () => {
    let ok = 0;
    for (const row of lines) {
      const got = parseAuctionText(row.text)?.eventType;
      if (got === row.want) ok++;
      else console.log("mismatch", row.text, "got", got, "want", row.want);
    }
    const recall = ok / lines.length;
    expect(recall).toBeGreaterThanOrEqual(0.9);
  });

  test("sale-worthy only strong solds with @buyer (precision gate)", () => {
    const solds = lines
      .map((l) => parseAuctionText(l.text))
      .filter((s) => s?.eventType === "sold");
    const worthy = solds.filter((s) => isSaleWorthy(s!));
    // Only the two @+price+currency lines should pass (satıldı alone and satıldı without @ fail)
    expect(worthy.length).toBe(2);
    expect(worthy.every((s) => s!.buyerHint && s!.amountTry)).toBe(true);
  });
});
