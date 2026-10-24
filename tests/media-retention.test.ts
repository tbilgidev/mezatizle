import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppEnv } from "../apps/api/src/lib/env.ts";
import {
  isMediaPurged,
  mediaPurgedNoteTr,
  mediaRetentionDaysFromEnv,
  mediaRetentionPolicy,
  planMediaPaths,
} from "../apps/api/src/modules/media_retention.ts";

function fakeEnv(storageRoot: string): AppEnv {
  return {
    host: "127.0.0.1",
    port: 43127,
    databaseUrl: "postgres://x",
    storageRoot,
    maxUploadBytes: 1_000_000,
    corsOrigin: "*",
    ffmpegPath: "ffmpeg",
    ffprobePath: "ffprobe",
    frameIntervalSeconds: 5,
    profile: {
      profile: "LOCAL",
      asrBackend: "mock",
      ocrBackend: "mock",
      llmBackend: "local-rules",
      allowPaidApis: false,
      hardSpendLimitUsd: 0,
    },
    hardSpendLimitUsd: 0,
  };
}

describe("media retention helpers", () => {
  test("default note is exact Turkish copy for 7 days", () => {
    expect(mediaPurgedNoteTr(7)).toBe(
      "Video 1 hafta sonra silindi; analiz duruyor",
    );
    expect(mediaRetentionPolicy(7).noteTr).toBe(
      "Video 1 hafta sonra silindi; analiz duruyor",
    );
  });

  test("MEDIA_RETENTION_DAYS parses with floor/clamp", () => {
    expect(mediaRetentionDaysFromEnv("7")).toBe(7);
    expect(mediaRetentionDaysFromEnv("0")).toBe(7);
    expect(mediaRetentionDaysFromEnv("abc")).toBe(7);
    expect(mediaRetentionDaysFromEnv("14")).toBe(14);
  });

  test("isMediaPurged reads snake/camel flags", () => {
    expect(isMediaPurged({})).toBe(false);
    expect(isMediaPurged({ mediaPurged: true })).toBe(true);
    expect(isMediaPurged({ media_purged_at: "2026-10-01T00:00:00Z" })).toBe(
      true,
    );
    expect(isMediaPurged({ mediaPurgedAt: "2026-10-01T00:00:00Z" })).toBe(true);
  });

  test("planMediaPaths lists mp4/part/ass/wav/frames and skips products", async () => {
    const root = await mkdtemp(join(tmpdir(), "mezat-ret-"));
    try {
      const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
      await mkdir(join(root, "recordings"), { recursive: true });
      await mkdir(join(root, "audio"), { recursive: true });
      await mkdir(join(root, "frames", id), { recursive: true });
      await mkdir(join(root, "products"), { recursive: true });
      await writeFile(join(root, "recordings", `${id}.mp4`), "video");
      await writeFile(join(root, "recordings", `${id}.mp4.part.mp4`), "part");
      await writeFile(join(root, "recordings", `${id}.comments.ass`), "ass");
      await writeFile(join(root, "audio", `${id}.wav`), "wav");
      await writeFile(join(root, "frames", id, "0001.jpg"), "frame");
      await writeFile(join(root, "products", `${id}.jpg`), "thumb");

      const plan = await planMediaPaths(
        fakeEnv(root),
        id,
        `recordings/${id}.mp4`,
      );
      const kinds = new Set(plan.filter((p) => p.exists).map((p) => p.kind));
      expect(kinds.has("mp4")).toBe(true);
      expect(kinds.has("part")).toBe(true);
      expect(kinds.has("ass")).toBe(true);
      expect(kinds.has("wav")).toBe(true);
      expect(kinds.has("frames_dir")).toBe(true);
      expect(plan.some((p) => p.abs.includes("/products/"))).toBe(false);
      expect(plan.some((p) => p.abs.includes("/secrets/"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
