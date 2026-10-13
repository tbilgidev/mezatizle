import { describe, expect, test } from "bun:test";
import {
  assertSafeRelativePath,
  normalizeInstagramUsername,
  parseAuctionText,
  resolveProfile,
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

  test("parses Turkish sold signal", () => {
    const s = parseAuctionText("Satıldı @mehmet_demo 700 TL");
    expect(s?.eventType).toBe("sold");
    expect(s?.amountTry).toBe(700);
    expect(s?.buyerHint).toBe("mehmet_demo");
  });
});
