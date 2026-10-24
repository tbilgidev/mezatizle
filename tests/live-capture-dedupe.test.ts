import { describe, expect, test } from "bun:test";
import {
  findActiveCaptureConflict,
  type ActiveCaptureDupRow,
} from "../apps/api/src/modules/live_capture.ts";

function row(
  partial: Partial<ActiveCaptureDupRow> &
    Pick<ActiveCaptureDupRow, "recording_id" | "username">,
): ActiveCaptureDupRow {
  return {
    watch_url: null,
    source_url: null,
    capture_status: "kaydediliyor",
    max_duration_minutes: null,
    last_probe_detail: null,
    capture_error: null,
    ...partial,
  };
}

describe("findActiveCaptureConflict", () => {
  test("matches same username case-insensitively", () => {
    const hit = findActiveCaptureConflict(
      [row({ recording_id: "r1", username: "NunusVintageShop" })],
      "nunusvintageshop",
      null,
    );
    expect(hit?.recording_id).toBe("r1");
  });

  test("matches same broadcast_id via watch_url", () => {
    const hit = findActiveCaptureConflict(
      [
        row({
          recording_id: "r1",
          username: "other_shop",
          watch_url:
            "https://www.instagram.com/other_shop/live/?broadcast_id=18075764501765140",
        }),
      ],
      "nunusvintageshop",
      "18075764501765140",
    );
    expect(hit?.recording_id).toBe("r1");
  });

  test("matches broadcast_id from last_probe_detail", () => {
    const hit = findActiveCaptureConflict(
      [
        row({
          recording_id: "r1",
          username: "other_shop",
          last_probe_detail: "playwright_live_ok bid=18075764501765140 viewers=26",
        }),
      ],
      "nunusvintageshop",
      "18075764501765140",
    );
    expect(hit?.recording_id).toBe("r1");
  });

  test("global single-flight: any active blocks a second seller", () => {
    const hit = findActiveCaptureConflict(
      [
        row({
          recording_id: "r1",
          username: "afra.vintagetaki",
          watch_url:
            "https://www.instagram.com/afra.vintagetaki/live/?broadcast_id=111",
        }),
      ],
      "nunusvintageshop",
      "18075764501765140",
    );
    expect(hit?.recording_id).toBe("r1");
    expect(hit?.username).toBe("afra.vintagetaki");
  });

  test("empty active list allows create", () => {
    expect(
      findActiveCaptureConflict([], "nunusvintageshop", "18075764501765140"),
    ).toBeUndefined();
  });
});
