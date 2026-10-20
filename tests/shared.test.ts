import { describe, expect, test } from "bun:test";
import {
  assertSafeRelativePath,
  enrichSoldFromBids,
  explainSaleTr,
  isAuctionNoise,
  isSaleWorthy,
  normalizeInstagramUsername,
  parseAuctionText,
  parseAuctionTexts,
  parseBuyerHint,
  parsePriceTry,
  parseSpokenBuyerName,
  parseTurkishWordAmount,
  reconcileMezatWindows,
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
