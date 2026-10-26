import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isSaleWorthy, parseAuctionText } from "@mezatizle/shared";

const expected = JSON.parse(
  readFileSync(
    join(import.meta.dir, "../fixtures/sample-live.expected.json"),
    "utf8",
  ),
) as {
  goldSales: Array<{ buyerUsername: string; amountTry: number }>;
  mustNotInventBuyers: string[];
};

describe("sample-live expected gold (rules)", () => {
  test("gold sold lines parse sale-worthy with correct @ + amount", () => {
    for (const g of expected.goldSales) {
      const line = `Satıldı @${g.buyerUsername} ${g.amountTry} TL`;
      const s = parseAuctionText(line);
      expect(s?.eventType).toBe("sold");
      expect(s?.buyerHint).toBe(g.buyerUsername);
      expect(s?.amountTry).toBe(g.amountTry);
      expect(isSaleWorthy(s!)).toBe(true);
    }
  });

  test("never invent buyer from bare first names", () => {
    for (const name of expected.mustNotInventBuyers) {
      const s = parseAuctionText(`Satıldı ${name} 700 TL`);
      expect(s?.buyerHint).toBeUndefined();
    }
  });
});
