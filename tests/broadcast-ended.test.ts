import { describe, expect, test } from "bun:test";
import { isBroadcastStatusEnded } from "../apps/api/src/modules/ig_live_playwright.ts";

describe("isBroadcastStatusEnded", () => {
  test("active-like statuses stay live", () => {
    for (const s of ["active", "ACTIVE", "running", "live", "joined"]) {
      expect(isBroadcastStatusEnded(s)).toBe(false);
    }
  });

  test("ended statuses finalize", () => {
    for (const s of [
      "stopped",
      "hard_stop",
      "interrupted",
      "post_live",
      "ended",
      "offline",
    ]) {
      expect(isBroadcastStatusEnded(s)).toBe(true);
    }
  });

  test("empty / unknown do not false-trigger", () => {
    expect(isBroadcastStatusEnded(null)).toBe(false);
    expect(isBroadcastStatusEnded("")).toBe(false);
    expect(isBroadcastStatusEnded("mystery_status_xyz")).toBe(false);
  });
});
