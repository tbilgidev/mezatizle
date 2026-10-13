import { describe, expect, test } from "bun:test";
import { parseLiveSourceInput } from "@mezatizle/shared";

describe("parseLiveSourceInput", () => {
  test("parses @username", () => {
    const p = parseLiveSourceInput("@Demo_Shop");
    expect(p.kind).toBe("username");
    expect(p.username).toBe("demo_shop");
    expect(p.watchUrl).toBe("https://www.instagram.com/demo_shop/live/");
  });

  test("parses live URL", () => {
    const p = parseLiveSourceInput("https://www.instagram.com/shop_x/live/");
    expect(p.kind).toBe("live_url");
    expect(p.username).toBe("shop_x");
  });

  test("parses profile URL", () => {
    const p = parseLiveSourceInput("https://instagram.com/shop_x/");
    expect(p.kind).toBe("profile_url");
    expect(p.username).toBe("shop_x");
  });

  test("rejects reel URL", () => {
    expect(() =>
      parseLiveSourceInput("https://www.instagram.com/reel/ABC123/"),
    ).toThrow();
  });

  test("rejects non-instagram host", () => {
    expect(() => parseLiveSourceInput("https://example.com/live")).toThrow();
  });
});
