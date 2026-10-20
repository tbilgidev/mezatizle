import { Hono } from "hono";
import type { Sql } from "@mezatizle/db";
import { MODULES } from "@mezatizle/shared";
import type { AppEnv } from "../lib/env.ts";
import { totalSpendUsd } from "../lib/cost.ts";
import { LIVE_CAPTURE_POLICY } from "../modules/live_capture.ts";
import {
  clearIgSession,
  getIgSessionStatus,
  saveIgCookiesFilePath,
  saveIgCookiesText,
  saveIgCredentials,
} from "../modules/ig_session.ts";
import { playwrightIgLogin } from "../modules/ig_playwright_login.ts";
import { CAPTURE_QUALITY } from "../modules/capture_quality.ts";
import {
  getAutoFollowLiveStatus,
  setAutoFollowLiveConfig,
  runAutoFollowPollCycle,
} from "../modules/auto_follow_live.ts";
import {
  mediaRetentionDaysFromEnv,
  mediaRetentionPolicy,
} from "../modules/media_retention.ts";
const CAPTURE_POLICY = LIVE_CAPTURE_POLICY;

export function metaRoutes(sql: Sql, env: AppEnv) {
  const app = new Hono();

  app.get("/health", (c) =>
    c.json({ ok: true, service: "mezatizle-api", profile: env.profile.profile }),
  );

  app.get("/settings", async (c) => {
    const spent = await totalSpendUsd(sql);
    const igSession = await getIgSessionStatus(env);
    const autoFollowLive = await getAutoFollowLiveStatus(env, sql);
    return c.json({
      profile: env.profile,
      hardSpendLimitUsd: env.hardSpendLimitUsd,
      spentUsd: spent,
      maxUploadBytes: env.maxUploadBytes,
      modules: MODULES,
      capture: CAPTURE_POLICY,
      captureQuality: CAPTURE_QUALITY,
      igSession,
      autoFollowLive,
      mediaRetention: mediaRetentionPolicy(mediaRetentionDaysFromEnv()),
      storageRoot: env.storageRoot,
      localProviders: {
        asr: {
          backend: env.profile.asrBackend,
          model: process.env.WHISPER_MODEL ?? "base",
          mockForced: process.env.FORCE_MOCK_ASR === "1",
        },
        ocr: {
          backend: env.profile.ocrBackend,
          engine: process.env.OCR_ENGINE ?? "tesseract",
          fps: Number(process.env.OCR_FPS ?? "1"),
          crop: process.env.OCR_CROP_FRAC ?? "0.45,0.35,0.98,0.95",
          mockForced: process.env.FORCE_MOCK_OCR === "1",
        },
      },
    });
  });

  app.get("/settings/auto-follow-live", async (c) => {
    return c.json(await getAutoFollowLiveStatus(env, sql));
  });

  app.patch("/settings/auto-follow-live", async (c) => {
    try {
      const body = (await c.req.json().catch(() => ({}))) as {
        enabled?: boolean;
        pollIntervalMs?: number;
      };
      const status = await setAutoFollowLiveConfig(env, {
        enabled: body.enabled,
        pollIntervalMs: body.pollIntervalMs,
      });
      return c.json(status);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, 400);
    }
  });

  /** Operator dry-run / force one poll cycle (does not require live). */
  app.post("/settings/auto-follow-live/poll-now", async (c) => {
    try {
      const body = (await c.req.json().catch(() => ({}))) as {
        dryRun?: boolean;
      };
      const dryRun = body.dryRun !== false; // default dry-run for safety
      const cycle = await runAutoFollowPollCycle(sql, env, { dryRun });
      const status = await getAutoFollowLiveStatus(env, sql);
      return c.json({ ...status, cycle, dryRun });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, 400);
    }
  });

  app.get("/settings/ig-session", async (c) => {
    return c.json(await getIgSessionStatus(env));
  });

  app.post("/settings/ig-session", async (c) => {
    try {
      const ct = c.req.header("content-type") || "";
      if (ct.includes("multipart/form-data")) {
        const body = await c.req.parseBody();
        const file = body["cookiesFile"];
        if (file instanceof File) {
          const text = await file.text();
          return c.json(await saveIgCookiesText(env, text));
        }
        return c.json({ error: "cookiesFile gerekli" }, 400);
      }
      const body = (await c.req.json()) as {
        cookiesText?: string;
        cookiesPath?: string;
        username?: string;
        password?: string;
      };
      if (body.cookiesText?.trim()) {
        return c.json(await saveIgCookiesText(env, body.cookiesText));
      }
      if (body.cookiesPath?.trim()) {
        return c.json(await saveIgCookiesFilePath(env, body.cookiesPath));
      }
      if (body.username?.trim() && body.password) {
        return c.json(
          await saveIgCredentials(env, body.username, body.password),
        );
      }
      return c.json(
        {
          error:
            "cookiesText, cookiesPath veya username+password alanlarından biri gerekli",
        },
        400,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: msg }, 400);
    }
  });

  app.delete("/settings/ig-session", async (c) => {
    return c.json(await clearIgSession(env));
  });

  app.post("/settings/ig-session/playwright-login", async (c) => {
    try {
      const body = (await c.req.json()) as {
        username?: string;
        password?: string;
        headless?: boolean;
      };
      if (!body.username?.trim() || !body.password) {
        return c.json({ error: "username ve password gerekli" }, 400);
      }
      const status = await playwrightIgLogin(env, {
        username: body.username,
        password: body.password,
        headless: body.headless !== false,
      });
      return c.json({
        ...status,
        noteTr:
          "Playwright ile giriş tamamlandı. Parola saklandı (••••); çerezler yt-dlp için yazıldı. Parola yanıtta yok.",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const shot =
        err && typeof err === "object" && "screenshotPath" in err
          ? String((err as { screenshotPath?: string }).screenshotPath ?? "")
          : "";
      const session = await getIgSessionStatus(env);
      return c.json(
        {
          error: msg,
          errorTr: msg,
          screenshotPath: shot || null,
          ...session,
        },
        400,
      );
    }
  });

  app.get("/metrics", async (c) => {
    const metrics = await sql`
      SELECT metric_name, COUNT(*)::int AS n, AVG(metric_value)::float AS avg_value
      FROM processing_metrics
      GROUP BY metric_name
      ORDER BY metric_name
    `;
    const usage = await sql`
      SELECT provider, operation, SUM(units)::float AS units, SUM(units * unit_cost_usd)::float AS cost_usd
      FROM api_usage
      GROUP BY provider, operation
      ORDER BY provider, operation
    `;
    return c.json({ metrics, usage, spentUsd: await totalSpendUsd(sql) });
  });

  app.get("/dashboard", async (c) => {
    const [recCounts] = await sql<{ total: string; complete: string; failed: string }[]>`
      SELECT
        COUNT(*)::text AS total,
        COUNT(*) FILTER (WHERE status = 'complete')::text AS complete,
        COUNT(*) FILTER (WHERE status = 'failed')::text AS failed
      FROM recordings
    `;
    const [saleCounts] = await sql<{ total: string; needs_review: string }[]>`
      SELECT
        COUNT(*)::text AS total,
        COUNT(*) FILTER (WHERE status = 'needs_review')::text AS needs_review
      FROM sales
    `;
    const [jobCounts] = await sql<{ queued: string; running: string }[]>`
      SELECT
        COUNT(*) FILTER (WHERE status = 'queued')::text AS queued,
        COUNT(*) FILTER (WHERE status = 'running')::text AS running
      FROM processing_jobs
    `;
    return c.json({
      recordings: recCounts,
      sales: saleCounts,
      jobs: jobCounts,
      profile: env.profile.profile,
      spentUsd: await totalSpendUsd(sql),
    });
  });

  app.post("/capture/start", (c) =>
    c.json(
      {
        error: "POST /api/recordings/live kullanın",
        policy: CAPTURE_POLICY,
      },
      410,
    ),
  );

  return app;
}
