import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendCommentAssCue,
  assDialogueLine,
  assHasCues,
  assHeader,
  COMMENT_DROUGHT_MINUTES,
  commentsAssPath,
  escapeAssText,
  escapeSubtitlesFilterPath,
  ensureCommentsAssFile,
  ffmpegBurnCommentsArgs,
  msToAssTime,
} from "../apps/api/src/modules/comment_burnin.ts";
import { isLiveViewerPresenceHealthy } from "../apps/api/src/modules/ig_live_playwright.ts";

describe("comment burn-in ASS", () => {
  test("msToAssTime formats H:MM:SS.cs", () => {
    expect(msToAssTime(0)).toBe("0:00:00.00");
    expect(msToAssTime(1_500)).toBe("0:00:01.50");
    expect(msToAssTime(65_230)).toBe("0:01:05.23");
    expect(msToAssTime(3_661_040)).toBe("1:01:01.04");
  });

  test("escapeAssText strips braces and newlines", () => {
    expect(escapeAssText("aldım {x}\nok")).toBe("aldım \\{x\\} ok");
  });

  test("assDialogueLine holds 8s and includes username", () => {
    const line = assDialogueLine({
      offsetMs: 12_000,
      username: "buyer1",
      text: "aldım 500",
    });
    expect(line).toContain("0:00:12.00");
    expect(line).toContain("0:00:20.00");
    expect(line).toContain("@buyer1");
    expect(line).toContain("aldım 500");
  });

  test("appendCommentAssCue writes header once then dialogues", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mz-ass-"));
    const assPath = join(dir, "rec.comments.ass");
    try {
      await appendCommentAssCue(assPath, {
        offsetMs: 1000,
        username: "a",
        text: "bir",
      });
      await appendCommentAssCue(assPath, {
        offsetMs: 5000,
        username: "b",
        text: "iki",
      });
      const text = await readFile(assPath, "utf8");
      expect(text.indexOf("[Script Info]")).toBe(0);
      expect((text.match(/\[Events\]/g) ?? []).length).toBe(1);
      expect((text.match(/^Dialogue:/gm) ?? []).length).toBe(2);
      expect(await assHasCues(assPath)).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("ensureCommentsAssFile is idempotent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mz-ass2-"));
    const assPath = join(dir, "x.comments.ass");
    try {
      await ensureCommentsAssFile(assPath);
      await writeFile(assPath, assHeader() + "Dialogue: 0,0:00:01.00,0:00:02.00,CommentHUD,,0,0,0,,hi\n");
      await ensureCommentsAssFile(assPath);
      const text = await readFile(assPath, "utf8");
      expect((text.match(/\[Events\]/g) ?? []).length).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("commentsAssPath and ffmpeg filter path escape", () => {
    expect(commentsAssPath("/data/recordings/abc.mp4")).toBe(
      "/data/recordings/abc.comments.ass",
    );
    expect(escapeSubtitlesFilterPath("/tmp/a:b.ass")).toContain("\\:");
    const args = ffmpegBurnCommentsArgs({
      ffmpegPath: "ffmpeg",
      inputPath: "/in.mp4",
      assPath: "/tmp/c.ass",
      outputPath: "/out.mp4",
    });
    expect(args).toContain("-vf");
    expect(args.some((a) => a.startsWith("subtitles="))).toBe(true);
    expect(args).toContain("-c:a");
    expect(args).toContain("copy");
  });

  test("drought threshold default is 2 minutes", () => {
    expect(COMMENT_DROUGHT_MINUTES).toBeGreaterThanOrEqual(1);
  });
});

describe("live viewer presence health gate", () => {
  test("missing session is unhealthy", () => {
    expect(isLiveViewerPresenceHealthy("no-such-recording")).toBe(false);
  });
});
