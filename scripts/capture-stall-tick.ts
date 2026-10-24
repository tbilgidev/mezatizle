#!/usr/bin/env bun
/**
 * Out-of-process capture stall tick (used by capture-stall-watchdog.sh when
 * the API is down or the HTTP nudge fails). Finalizes stale kaydediliyor /
 * opens part-2 when the IG live is still on. Never wipes comments.
 */
import { createSql } from "@mezatizle/db";
import { loadEnv } from "../apps/api/src/lib/env.ts";
import { runCaptureStallWatchdogTick } from "../apps/api/src/modules/live_capture.ts";

const env = loadEnv();
const sql = createSql(env.databaseUrl);
console.log(`[capture-stall-tick] start ${new Date().toISOString()}`);
await runCaptureStallWatchdogTick(sql, env);
console.log(`[capture-stall-tick] done ${new Date().toISOString()}`);
await sql.end({ timeout: 2 }).catch(() => undefined);
