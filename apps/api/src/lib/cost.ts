import type { Sql } from "@mezatizle/db";

export async function recordApiUsage(
  sql: Sql,
  opts: {
    provider: string;
    operation: string;
    units?: number;
    unitCostUsd?: number;
    recordingId?: string | null;
    meta?: Record<string, unknown>;
  },
) {
  await sql`
    INSERT INTO api_usage (provider, operation, units, unit_cost_usd, recording_id, meta)
    VALUES (
      ${opts.provider},
      ${opts.operation},
      ${opts.units ?? 1},
      ${opts.unitCostUsd ?? 0},
      ${opts.recordingId ?? null},
      ${sql.json(opts.meta ?? {})}
    )
  `;
}

export async function totalSpendUsd(sql: Sql): Promise<number> {
  const rows = await sql<{ total: string }[]>`
    SELECT COALESCE(SUM(units * unit_cost_usd), 0)::text AS total FROM api_usage
  `;
  return Number(rows[0]?.total ?? 0);
}

export async function assertUnderSpendLimit(
  sql: Sql,
  hardLimitUsd: number,
): Promise<void> {
  if (!hardLimitUsd || hardLimitUsd <= 0) return;
  const spent = await totalSpendUsd(sql);
  if (spent >= hardLimitUsd) {
    throw new Error(
      `Hard spend limit reached ($${spent.toFixed(4)} >= $${hardLimitUsd})`,
    );
  }
}

export async function recordMetric(
  sql: Sql,
  opts: {
    name: string;
    value: number;
    unit?: string;
    recordingId?: string | null;
    jobId?: string | null;
    labels?: Record<string, unknown>;
  },
) {
  await sql`
    INSERT INTO processing_metrics (recording_id, job_id, metric_name, metric_value, unit, labels)
    VALUES (
      ${opts.recordingId ?? null},
      ${opts.jobId ?? null},
      ${opts.name},
      ${opts.value},
      ${opts.unit ?? null},
      ${sql.json(opts.labels ?? {})}
    )
  `;
}
