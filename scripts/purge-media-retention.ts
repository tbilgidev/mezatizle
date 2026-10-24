#!/usr/bin/env bun
/**
 * Retention job: delete aged recording VIDEO files; keep analysis DB + product thumbs.
 *
 * Usage:
 *   bun scripts/purge-media-retention.ts --dry-run
 *   bun scripts/purge-media-retention.ts
 *   MEDIA_RETENTION_DAYS=7 bun scripts/purge-media-retention.ts --dry-run
 *
 * Safe while a live capture is kaydediliyor — candidates never include active captures.
 * Does NOT restart the API.
 */
import { createSql } from "@mezatizle/db";
import { loadEnv } from "../apps/api/src/lib/env.ts";
import {
  mediaRetentionDaysFromEnv,
  mediaRetentionPolicy,
  runMediaRetentionPurge,
} from "../apps/api/src/modules/media_retention.ts";

function parseArgs(argv: string[]) {
  const dryRun = argv.includes("--dry-run") || argv.includes("-n");
  const daysArg = argv.find((a) => a.startsWith("--days="));
  const days = daysArg
    ? Number(daysArg.slice("--days=".length))
    : mediaRetentionDaysFromEnv();
  // Allow 0 for dry-run / ops checks (everything already aged); default 7.
  const retentionDays = Number.isFinite(days)
    ? Math.max(0, Math.floor(days))
    : 7;
  return { dryRun, retentionDays };
}

async function main() {
  const { dryRun, retentionDays } = parseArgs(process.argv.slice(2));
  const env = loadEnv();
  const policy = mediaRetentionPolicy(retentionDays);
  const sql = createSql(env.databaseUrl);

  console.log(
    JSON.stringify(
      {
        at: new Date().toISOString(),
        dryRun,
        retentionDays,
        policyLabel: policy.labelTr,
        storageRoot: env.storageRoot,
      },
      null,
      2,
    ),
  );

  try {
    const out = await runMediaRetentionPurge(sql, env, {
      dryRun,
      retentionDays,
    });

    const lines = out.results.map((r) => ({
      recordingId: r.recordingId,
      eligible: r.eligible,
      skippedReason: r.skippedReason ?? null,
      bytesRemoved: r.bytesRemoved,
      files: r.files
        .filter((f) => f.exists)
        .map((f) => ({
          kind: f.kind,
          abs: f.abs,
          sizeBytes: f.sizeBytes,
        })),
      mediaPurgedAt: r.mediaPurgedAt ?? null,
    }));

    console.log(
      JSON.stringify(
        {
          candidateCount: out.candidates.length,
          totalBytes: out.totalBytes,
          totalMiB: Math.round((out.totalBytes / (1024 * 1024)) * 10) / 10,
          candidates: out.candidates.map((c) => ({
            id: c.id,
            status: c.status,
            captureStatus: c.captureStatus,
            ageAnchorAt: c.ageAnchorAt,
            analysisFinishedAt: c.analysisFinishedAt,
            fileSizeBytes: c.fileSizeBytes,
          })),
          results: lines,
        },
        null,
        2,
      ),
    );

    if (dryRun) {
      console.log(
        out.candidates.length
          ? `dry-run: would purge ${out.candidates.length} recording(s), ~${Math.round(out.totalBytes / (1024 * 1024))} MiB`
          : "dry-run: nothing eligible (likely all under retention window or already purged)",
      );
    } else {
      console.log(
        out.results.filter((r) => r.eligible).length
          ? `purged ${out.results.filter((r) => r.eligible).length} recording(s), removed ~${Math.round(out.totalBytes / (1024 * 1024))} MiB`
          : "nothing to purge",
      );
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
