import { describe, expect, test } from "bun:test";
import {
  deriveAnalysisProgress,
  deriveAnalysisState,
} from "../apps/api/src/lib/recording-enrich.ts";
import { analysisFrameFps } from "../apps/api/src/lib/ffmpeg.ts";
import { prerequisitesMet } from "../apps/api/src/worker.ts";

describe("deriveAnalysisState — cancelled ≠ done", () => {
  test("all-cancelled wave is not done (afra false 0/0)", () => {
    const jobs = [
      { job_type: "probe_media", status: "cancelled" },
      { job_type: "extract_audio_frames", status: "cancelled" },
      { job_type: "transcribe", status: "cancelled" },
      { job_type: "ocr_frames", status: "cancelled" },
      { job_type: "segment_auction", status: "cancelled" },
      { job_type: "reconcile_sales", status: "cancelled" },
    ];
    expect(deriveAnalysisState("ready", jobs)).toBe("none");
    const prog = deriveAnalysisProgress(jobs);
    expect(prog.analysisProgress).toBeLessThan(100);
    expect(prog.analysisStage).not.toBe("Tamamlandı");
  });

  test("full succeeded pipeline is done", () => {
    const jobs = [
      { job_type: "probe_media", status: "succeeded" },
      { job_type: "extract_audio_frames", status: "succeeded" },
      { job_type: "transcribe", status: "succeeded" },
      { job_type: "ocr_frames", status: "succeeded" },
      { job_type: "segment_auction", status: "succeeded" },
      { job_type: "reconcile_sales", status: "succeeded" },
    ];
    expect(deriveAnalysisState("complete", jobs)).toBe("done");
    expect(deriveAnalysisProgress(jobs).analysisProgress).toBe(100);
  });

  test("running extract keeps state running", () => {
    const jobs = [
      { job_type: "probe_media", status: "succeeded" },
      { job_type: "extract_audio_frames", status: "running", progress_percent: 20 },
      { job_type: "transcribe", status: "queued" },
    ];
    expect(deriveAnalysisState("extracting", jobs)).toBe("running");
  });
});

describe("analysisFrameFps", () => {
  test("caps fps for multi-hour recording so we stay near OCR_MAX_FRAMES", () => {
    const fps = analysisFrameFps({
      intervalSeconds: 1,
      durationSeconds: 13674,
      maxFrames: 120,
    });
    expect(fps).toBeLessThan(0.02);
    expect(fps * 13674).toBeLessThanOrEqual(130);
    expect(fps * 13674).toBeGreaterThan(50);
  });
});

describe("prerequisitesMet", () => {
  test("cancelled dependency is not ok", async () => {
    const calls: string[] = [];
    const sql = Object.assign(
      async (strings: TemplateStringsArray, ...values: unknown[]) => {
        calls.push(String(strings[0]));
        void values;
        return [{ status: "cancelled" }];
      },
      { json: (v: unknown) => v },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await prerequisitesMet(sql as any, "rec", "transcribe");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("extract_audio_frames");
      expect(r.reason).toContain("cancelled");
    }
  });
});
