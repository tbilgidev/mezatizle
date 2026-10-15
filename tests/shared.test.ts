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
  resolveProfile,
  SALE_MIN_CONFIDENCE,
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
    expect(s?.amountTry).toBe(700);
    expect(s?.buyerHint).toBe("mehmet_demo");
    expect(s!.confidence).toBeGreaterThanOrEqual(0.9);
    expect(isSaleWorthy(s!)).toBe(true);
  });

  test("aldım is bid never sold", () => {
    const s = parseAuctionText("aldım 500 TL");
    expect(s?.eventType).toBe("bid");
    expect(s?.amountTry).toBe(500);
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
    // price+currency still sale-worthy; buyer stays unknown
    expect(isSaleWorthy(s!)).toBe(true);
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
    expect(solds.every((s) => !s.buyerHint)).toBe(true); // no @ invented
    expect(solds.every((s) => isSaleWorthy(s))).toBe(true);
  });
});

/** Fixture gold labels — precision/recall-ish for rule layer (no ASR). */
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
    { text: "satıldı", want: "sold" }, // weak — not sale-worthy
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

  test("sale-worthy only strong solds (precision gate)", () => {
    const solds = lines
      .map((l) => parseAuctionText(l.text))
      .filter((s) => s?.eventType === "sold");
    const worthy = solds.filter((s) => isSaleWorthy(s!));
    // "satıldı" alone must not pass; two @+price lines should
    expect(worthy.length).toBe(2);
    expect(worthy.every((s) => s!.buyerHint && s!.amountTry)).toBe(true);
  });
});
