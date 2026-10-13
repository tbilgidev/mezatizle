import { Hono } from "hono";
import type { Sql } from "@mezatizle/db";
import { MODULES } from "@mezatizle/shared";
import type { AppEnv } from "../lib/env.ts";
import { totalSpendUsd } from "../lib/cost.ts";
import { CAPTURE_POLICY } from "../modules/capture_stub.ts";

export function metaRoutes(sql: Sql, env: AppEnv) {
  const app = new Hono();

  app.get("/health", (c) =>
    c.json({ ok: true, service: "mezatizle-api", profile: env.profile.profile }),
  );

  app.get("/settings", async (c) => {
    const spent = await totalSpendUsd(sql);
    return c.json({
      profile: env.profile,
      hardSpendLimitUsd: env.hardSpendLimitUsd,
      spentUsd: spent,
      maxUploadBytes: env.maxUploadBytes,
      modules: MODULES,
      capture: CAPTURE_POLICY,
      storageRoot: env.storageRoot,
    });
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
    c.json({ error: CAPTURE_POLICY.message, restrictions: CAPTURE_POLICY.restrictions }, 403),
  );

  return app;
}
