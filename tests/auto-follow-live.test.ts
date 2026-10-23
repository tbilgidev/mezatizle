import { describe, expect, test, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseHtmlLiveSignals,
  parseReelsTrayLives,
  type FollowingLive,
  orderFollowingForProbe,
  sliceRotated,
  advanceProbeCursor,
  estimateFullSweepMinutes,
  formatSweepEtaTr,
  clampProbeBatchSize,
  saveFollowingCache,
  loadFollowingCache,
  emptyFollowingCache,
} from "../apps/api/src/modules/ig_following_lives.ts";
import {
  filterLivesNeedingCapture,
  runAutoFollowPollCycle,
  setAutoFollowLiveConfig,
  getAutoFollowLiveConfig,
  getAutoFollowLiveStatus,
  hasBlockingActiveCapture,
  nextPollSleepMs,
  clampPollIntervalMs,
  nextEveningScanAt,
  currentDueSlotKey,
  utcToIstanbulWall,
  istanbulWallToUtc,
  SCAN_SLOTS_HM,
  SCAN_SLOT_LABELS_TR,
  SCAN_TIMEZONE,
  SLOT_FIRE_GRACE_MS,
  POLL_MS_MIN,
  POLL_MS_MAX,
  POLL_MS_DEFAULT,
  POLL_HARD_TIMEOUT_MS,
  type ActiveCaptureRef,
} from "../apps/api/src/modules/auto_follow_live.ts";
import { findActiveCaptureConflict } from "../apps/api/src/modules/live_capture.ts";
import type { AppEnv } from "../apps/api/src/lib/env.ts";
import { parseLiveSourceInput } from "@mezatizle/shared";

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

describe("parseReelsTrayLives", () => {
  test("extracts broadcast from tray items", () => {
    const lives = parseReelsTrayLives({
      tray: [
        {
          user: { username: "YesilKoyAntika_" },
          broadcast: {
            id: "18093629261179067",
            broadcast_status: "active",
            viewer_count: 42,
          },
        },
        {
          user: { username: "offline_shop" },
          items: [{ id: "1" }],
        },
        {
          username: "ended_live",
          broadcast_status: "stopped",
          id: "11111111111111111",
        },
      ],
    });
    expect(lives.some((l) => l.username === "yesilkoyantika_")).toBe(true);
    const y = lives.find((l) => l.username === "yesilkoyantika_")!;
    expect(y.broadcastId).toBe("18093629261179067");
    expect(y.watchUrl).toContain("broadcast_id=18093629261179067");
    expect(lives.some((l) => l.username === "ended_live")).toBe(false);
  });

  test("parses /live/ href paths from html", () => {
    const html = `<a href="/afra.vintagetaki/live/">Live</a> https://www.instagram.com/other_shop/live/?broadcast_id=1`;
    const lives = parseHtmlLiveSignals(html);
    expect(lives.some((l) => l.username === "afra.vintagetaki")).toBe(true);
    expect(lives.some((l) => l.username === "other_shop")).toBe(true);
  });

  test("parses html live_broadcast_id pairs", () => {
    const html = `"username":"demo_shop","foo":1,"live_broadcast_id":"12345678901234567"`;
    const lives = parseHtmlLiveSignals(html);
    expect(lives).toHaveLength(1);
    expect(lives[0]!.username).toBe("demo_shop");
    expect(lives[0]!.broadcastId).toBe("12345678901234567");
  });
});

describe("evening Istanbul scan slots", () => {
  test("slots are 20:05 / 21:05 / 22:05 Europe/Istanbul", () => {
    expect(SCAN_TIMEZONE).toBe("Europe/Istanbul");
    expect(SCAN_SLOT_LABELS_TR).toBe("20:05, 21:05, 22:05");
    expect(SCAN_SLOTS_HM).toEqual([
      { hour: 20, minute: 5 },
      { hour: 21, minute: 5 },
      { hour: 22, minute: 5 },
    ]);
  });

  test("nextScanAt is one of the three Istanbul wall times", () => {
    // 2026-10-23 14:00 Istanbul = 11:00 UTC
    const afternoon = istanbulWallToUtc(2026, 10, 23, 14, 0);
    const next = nextEveningScanAt(afternoon);
    const wall = utcToIstanbulWall(next);
    expect(wall.hour).toBe(20);
    expect(wall.minute).toBe(5);
    expect(wall.day).toBe(23);
  });

  test("after 20:05 next is 21:05; after 22:05 next is next-day 20:05", () => {
    const after20 = istanbulWallToUtc(2026, 10, 23, 20, 10);
    // past grace → 21:05
    const pastGrace = new Date(
      istanbulWallToUtc(2026, 10, 23, 20, 5).getTime() + SLOT_FIRE_GRACE_MS + 1,
    );
    const n21 = nextEveningScanAt(pastGrace);
    const w21 = utcToIstanbulWall(n21);
    expect(w21.hour).toBe(21);
    expect(w21.minute).toBe(5);

    const pastLast = new Date(
      istanbulWallToUtc(2026, 10, 23, 22, 5).getTime() + SLOT_FIRE_GRACE_MS + 1,
    );
    const nNext = nextEveningScanAt(pastLast);
    const wNext = utcToIstanbulWall(nNext);
    expect(wNext.day).toBe(24);
    expect(wNext.hour).toBe(20);
    expect(wNext.minute).toBe(5);

    // within grace of 20:05 → still due that slot
    const due = currentDueSlotKey(
      new Date(istanbulWallToUtc(2026, 10, 23, 20, 5).getTime() + 30_000),
    );
    expect(due).toBe("2026-10-23T20:05");
    expect(currentDueSlotKey(after20)).toBeNull();
  });

  test("status exposes nextScanAt + schedule copy", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mezat-af-sched-"));
    try {
      const st = await getAutoFollowLiveStatus(fakeEnv(dir), null);
      expect(st.scanWindowsTr).toBe(SCAN_SLOT_LABELS_TR);
      expect(st.scanTimezone).toBe(SCAN_TIMEZONE);
      expect(st.nextScanAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(st.scheduleHintTr).toMatch(/20:05/);
      expect(st.hintTr).toMatch(/İstanbul|20:05/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("poll interval helpers (legacy / 429 backoff)", () => {
  test("clamps and defaults to ~5.5 min", () => {
    expect(clampPollIntervalMs(90_000)).toBe(POLL_MS_MIN);
    expect(clampPollIntervalMs(400_000)).toBe(POLL_MS_MAX);
    expect(clampPollIntervalMs(POLL_MS_DEFAULT)).toBe(POLL_MS_DEFAULT);
    expect(POLL_MS_MIN).toBe(300_000);
    expect(POLL_MS_MAX).toBe(360_000);
  });

  test("jitter stays in 5–6 min; rate-limit ≥ 12 min", () => {
    for (let i = 0; i < 20; i++) {
      const ms = nextPollSleepMs(POLL_MS_DEFAULT, { random: () => i / 20 });
      expect(ms).toBeGreaterThanOrEqual(POLL_MS_MIN);
      expect(ms).toBeLessThanOrEqual(POLL_MS_MAX);
    }
    const rl = nextPollSleepMs(POLL_MS_DEFAULT, {
      rateLimited: true,
      random: () => 0,
    });
    expect(rl).toBeGreaterThanOrEqual(POLL_MS_MAX * 2);
  });

  test("poll hard-timeout is a finite safety net", () => {
    expect(POLL_HARD_TIMEOUT_MS).toBeGreaterThanOrEqual(90_000);
    expect(POLL_HARD_TIMEOUT_MS).toBeLessThanOrEqual(180_000);
  });
});

describe("global single capture conflict", () => {
  test("blocks second seller while any capture active", () => {
    const rows = [
      {
        recording_id: "r1",
        username: "shop_a",
        watch_url: null,
        source_url: null,
        capture_status: "kaydediliyor",
        max_duration_minutes: null,
        last_probe_detail: null,
        capture_error: null,
      },
    ];
    const hit = findActiveCaptureConflict(rows, "shop_b", null);
    expect(hit?.recording_id).toBe("r1");
    expect(hit?.username).toBe("shop_a");
  });
});

describe("full following rotation", () => {
  test("priority only soft-boosts order; slice+cursor covers all", () => {
    const following = ["z_shop", "nunusvintageshop", "a_shop", "mid"];
    const ordered = orderFollowingForProbe(following, [
      "nunusvintageshop",
      "afra.vintagetaki",
    ]);
    expect(ordered[0]).toBe("nunusvintageshop");
    expect(ordered).toContain("a_shop");
    expect(ordered).toHaveLength(4);

    const batch1 = sliceRotated(ordered, 0, 2);
    expect(batch1).toEqual([ordered[0], ordered[1]]);
    const adv1 = advanceProbeCursor(ordered.length, 0, 2);
    expect(adv1.completedSweep).toBe(false);
    const batch2 = sliceRotated(ordered, adv1.nextCursor, 2);
    expect(batch2).toHaveLength(2);
    const adv2 = advanceProbeCursor(ordered.length, adv1.nextCursor, 2);
    expect(adv2.completedSweep).toBe(true);
    expect(adv2.nextCursor).toBe(0);

    const seen = new Set([...batch1, ...batch2]);
    expect(seen.size).toBe(4);
  });

  test("ETA documents full sweep window", () => {
    expect(clampProbeBatchSize(8)).toBe(8);
    expect(estimateFullSweepMinutes(40, 8, 330_000)).toBe(27.5);
    expect(formatSweepEtaTr(40, 8, 330_000)).toMatch(/≈27\.5 dk/);
  });

  test("following cache persists usernames + sweep time", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mezat-fc-"));
    try {
      const env = fakeEnv(dir);
      const state = emptyFollowingCache();
      state.usernames = ["shop_a", "shop_b", "nunusvintageshop"];
      state.refreshedAt = "2026-10-22T10:00:00.000Z";
      state.lastFullSweepAt = "2026-10-22T11:00:00.000Z";
      state.probeCursor = 2;
      await saveFollowingCache(env, state);
      const loaded = await loadFollowingCache(env);
      expect(loaded.usernames).toEqual([
        "shop_a",
        "shop_b",
        "nunusvintageshop",
      ]);
      expect(loaded.lastFullSweepAt).toBe("2026-10-22T11:00:00.000Z");
      expect(loaded.probeCursor).toBe(2);

      const st = await getAutoFollowLiveStatus(env, null);
      expect(st.followingCount).toBe(3);
      expect(st.lastFullSweepAt).toBe("2026-10-22T11:00:00.000Z");
      expect(st.fullSweepEtaTr).toMatch(/dk/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("priority usernames", () => {
  test("defaults soft-boost afra/glam/nunus (not coverage set)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mezat-af-"));
    try {
      const cfg = await getAutoFollowLiveConfig(fakeEnv(dir));
      expect(cfg.priorityUsernames).toContain("afra.vintagetaki");
      expect(cfg.priorityUsernames).toContain("glamvintage_");
      expect(cfg.priorityUsernames).toContain("glamvintage");
      expect(cfg.priorityUsernames).toContain("nunusvintageshop");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("hasBlockingActiveCapture", () => {
  test("true for bekleniyor / kaydediliyor", () => {
    expect(
      hasBlockingActiveCapture([
        {
          recordingId: "r1",
          username: "shop",
          broadcastId: null,
          status: "recording",
          captureStatus: "kaydediliyor",
        },
      ]),
    ).toBe(true);
    expect(
      hasBlockingActiveCapture([
        {
          recordingId: "r2",
          username: "shop",
          broadcastId: null,
          status: "waiting",
          captureStatus: "bekleniyor",
        },
      ]),
    ).toBe(true);
    expect(hasBlockingActiveCapture([])).toBe(false);
  });
});

describe("filterLivesNeedingCapture", () => {
  test("dedupes by username and broadcast id", () => {
    const discovered: FollowingLive[] = [
      {
        username: "a_shop",
        broadcastId: "11111111111111111",
        watchUrl: "https://www.instagram.com/a_shop/live/?broadcast_id=11111111111111111",
      },
      {
        username: "b_shop",
        broadcastId: "22222222222222222",
        watchUrl: "https://www.instagram.com/b_shop/live/?broadcast_id=22222222222222222",
      },
      {
        username: "c_shop",
        broadcastId: "33333333333333333",
        watchUrl: "https://www.instagram.com/c_shop/live/?broadcast_id=33333333333333333",
      },
    ];
    const active: ActiveCaptureRef[] = [
      {
        recordingId: "r1",
        username: "a_shop",
        broadcastId: "11111111111111111",
        status: "recording",
        captureStatus: "kaydediliyor",
      },
      {
        recordingId: "r2",
        username: "other",
        broadcastId: "22222222222222222",
        status: "waiting",
        captureStatus: "bekleniyor",
      },
    ];
    const needed = filterLivesNeedingCapture(discovered, active);
    expect(needed.map((n) => n.username)).toEqual(["c_shop"]);
  });
});

describe("parseLiveSourceInput broadcast_id", () => {
  test("keeps broadcast_id on live URL", () => {
    const p = parseLiveSourceInput(
      "https://www.instagram.com/shop_x/live/?broadcast_id=18093629261179067",
    );
    expect(p.username).toBe("shop_x");
    expect(p.watchUrl).toContain("broadcast_id=18093629261179067");
  });
});

describe("auto-follow poll→enqueue (mocked)", () => {
  const dirs: string[] = [];

  afterAll(async () => {
    for (const d of dirs) {
      await rm(d, { recursive: true, force: true });
    }
  });

  test("dry-run enqueue path with mocked poll", async () => {
    const root = await mkdtemp(join(tmpdir(), "mz-af-"));
    dirs.push(root);
    const env = fakeEnv(root);
    await setAutoFollowLiveConfig(env, {
      enabled: true,
      pollIntervalMs: POLL_MS_DEFAULT,
    });

    const sql = {
      // listActiveLiveCaptures uses tagged template — stub empty
      async end() {},
    } as unknown as import("@mezatizle/db").Sql;

    // Override listActive by injecting poll + enqueue only; listActive will fail
    // without real SQL. Use a thin fake that returns [] for the SELECT shape.
    const fakeSql = ((strings: TemplateStringsArray, ..._v: unknown[]) => {
      const q = strings.join(" ");
      if (/FROM live_captures/i.test(q)) return Promise.resolve([]);
      return Promise.resolve([]);
    }) as unknown as import("@mezatizle/db").Sql;

    const enqueuedInputs: string[] = [];
    const cycle = await runAutoFollowPollCycle(fakeSql, env, {
      dryRun: false,
      poll: async () => ({
        ok: true as const,
        source: "reels_tray" as const,
        detail: "2 takip canlısı (mock)",
        followingCount: 2,
        lastFullSweepAt: null,
        lastFollowingRefreshAt: null,
        probedThisCycle: [],
        probeCursor: 0,
        completedSweep: false,
        lives: [
          {
            username: "mock_seller_a",
            broadcastId: "19999999999999999",
            watchUrl:
              "https://www.instagram.com/mock_seller_a/live/?broadcast_id=19999999999999999",
          },
          {
            username: "mock_seller_b",
            broadcastId: null,
            watchUrl: "https://www.instagram.com/mock_seller_b/live/",
          },
        ],
      }),
      enqueue: async (_sql, _env, opts) => {
        enqueuedInputs.push(opts.input);
        return {
          recordingId: `rec-${opts.input}`,
          username: "x",
          watchUrl: opts.input,
          captureStatus: "bekleniyor",
          lastError: null,
          lastProbeDetail: "mock",
          maxDurationMinutes: null,
          quality: {} as never,
          policy: {} as never,
        };
      },
    });

    expect(cycle.discovered).toHaveLength(2);
    // Only one concurrent auto recording — first live only
    expect(enqueuedInputs).toHaveLength(1);
    expect(enqueuedInputs[0]).toContain("broadcast_id=19999999999999999");
    expect(cycle.enqueued.some((e) => e.skipped === "max_one_concurrent")).toBe(
      true,
    );
    expect(cycle.enqueued.find((e) => e.username === "mock_seller_a")?.recordingId).toBeTruthy();

    // Second cycle: active list now includes those users → no new enqueue
    const fakeSql2 = ((strings: TemplateStringsArray) => {
      const q = strings.join(" ");
      if (/FROM live_captures/i.test(q)) {
        return Promise.resolve([
          {
            recording_id: "rec-a",
            username: "mock_seller_a",
            watch_url:
              "https://www.instagram.com/mock_seller_a/live/?broadcast_id=19999999999999999",
            source_url: null,
            status: "recording",
            capture_status: "kaydediliyor",
          },
          {
            recording_id: "rec-b",
            username: "mock_seller_b",
            watch_url: "https://www.instagram.com/mock_seller_b/live/",
            source_url: null,
            status: "waiting",
            capture_status: "bekleniyor",
          },
        ]);
      }
      return Promise.resolve([]);
    }) as unknown as import("@mezatizle/db").Sql;

    let enqueueCalls = 0;
    const cycle2 = await runAutoFollowPollCycle(fakeSql2, env, {
      poll: async () => ({
        ok: true as const,
        source: "reels_tray" as const,
        detail: "same",
        followingCount: 2,
        lastFullSweepAt: null,
        lastFollowingRefreshAt: null,
        probedThisCycle: [],
        probeCursor: 0,
        completedSweep: false,
        lives: [
          {
            username: "mock_seller_a",
            broadcastId: "19999999999999999",
            watchUrl:
              "https://www.instagram.com/mock_seller_a/live/?broadcast_id=19999999999999999",
          },
          {
            username: "mock_seller_b",
            broadcastId: null,
            watchUrl: "https://www.instagram.com/mock_seller_b/live/",
          },
        ],
      }),
      enqueue: async () => {
        enqueueCalls += 1;
        throw new Error("should not enqueue");
      },
    });
    // Active capture → pause: no IG poll, no enqueue
    expect(enqueueCalls).toBe(0);
    expect(cycle2.polled).toBe(false);
    expect(cycle2.paused).toBe(true);
    expect(cycle2.detail).toMatch(/duraklatıldı/);

    const st = await getAutoFollowLiveStatus(env, null);
    expect(st.enabled).toBe(true);
    expect(st.pollIntervalMs).toBe(POLL_MS_DEFAULT);
    expect(st.labelTr).toContain("açık");

    void sql;
  });

  test("pauses scan when kaydediliyor is active (simulated)", async () => {
    const root = await mkdtemp(join(tmpdir(), "mz-af-pause-"));
    dirs.push(root);
    const env = fakeEnv(root);
    await setAutoFollowLiveConfig(env, { enabled: true });

    let pollCalls = 0;
    const fakeSql = ((strings: TemplateStringsArray) => {
      const q = strings.join(" ");
      if (/FROM live_captures/i.test(q)) {
        return Promise.resolve([
          {
            recording_id: "rec-active",
            username: "live_shop",
            watch_url: "https://www.instagram.com/live_shop/live/",
            source_url: null,
            status: "recording",
            capture_status: "kaydediliyor",
          },
        ]);
      }
      return Promise.resolve([]);
    }) as unknown as import("@mezatizle/db").Sql;

    const cycle = await runAutoFollowPollCycle(fakeSql, env, {
      poll: async () => {
        pollCalls += 1;
        return {
          ok: true,
          source: "reels_tray",
          detail: "should not run",
          lives: [
            {
              username: "other_live",
              broadcastId: "18888888888888888",
              watchUrl:
                "https://www.instagram.com/other_live/live/?broadcast_id=18888888888888888",
            },
          ],
        };
      },
      enqueue: async () => {
        throw new Error("should not enqueue while paused");
      },
    });

    expect(pollCalls).toBe(0);
    expect(cycle.paused).toBe(true);
    expect(cycle.polled).toBe(false);
    expect(cycle.enqueued).toHaveLength(0);

    const st = await getAutoFollowLiveStatus(env, fakeSql);
    expect(st.scanPaused).toBe(true);
    expect(st.currentlyWatching.some((w) => w.username === "live_shop")).toBe(
      true,
    );
  });

  test("toggle persists enabled=false", async () => {
    const root = await mkdtemp(join(tmpdir(), "mz-af-"));
    dirs.push(root);
    const env = fakeEnv(root);
    const off = await setAutoFollowLiveConfig(env, { enabled: false });
    expect(off.enabled).toBe(false);
    expect(off.labelTr).toContain("kapalı");
    const on = await setAutoFollowLiveConfig(env, { enabled: true });
    expect(on.enabled).toBe(true);
  });
});
