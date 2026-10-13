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
const CAPTURE_POLICY = LIVE_CAPTURE_POLICY;

export function metaRoutes(sql: Sql, env: AppEnv) {
  const app = new Hono();

  app.get("/health", (c) =>
    c.json({ ok: true, service: "mezatizle-api", profile: env.profile.profile }),
  );

  app.get("/settings", async (c) => {
    const spent = await totalSpendUsd(sql);
    const igSession = await getIgSessionStatus(env);
    return c.json({
      profile: env.profile,
      hardSpendLimitUsd: env.hardSpendLimitUsd,
      spentUsd: spent,
      maxUploadBytes: env.maxUploadBytes,
      modules: MODULES,
      capture: CAPTURE_POLICY,
      igSession,
      storageRoot: env.storageRoot,
    });
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
