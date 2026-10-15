/**
 * Attach a spare-account Playwright live viewer presence to an in-flight
 * recording without touching ffmpeg. Stops when the ffmpeg pid exits
 * (or Ctrl+C).
 *
 * Usage:
 *   bun scripts/attach-live-viewer.ts <recordingId>
 */
import { loadEnv } from "../apps/api/src/lib/env.ts";
import {
  extractBroadcastIdFromUrl,
  startLiveViewerPresence,
  stopLiveViewerPresence,
  usernameFromWatchUrl,
} from "../apps/api/src/modules/ig_live_playwright.ts";
import postgres from "postgres";

const recordingId = process.argv[2];
if (!recordingId) {
  console.error("Usage: bun scripts/attach-live-viewer.ts <recordingId>");
  process.exit(1);
}

const env = loadEnv();
const sql = postgres(env.databaseUrl, { max: 1 });

const rows = await sql<{
  watch_url: string;
  process_pid: number | null;
  status: string;
  resolved_username: string;
}[]>`
  SELECT watch_url, process_pid, status, resolved_username
  FROM live_captures
  WHERE recording_id = ${recordingId}
`;

if (!rows[0]) {
  console.error("recording not found");
  await sql.end();
  process.exit(1);
}

const row = rows[0];
console.log(
  JSON.stringify({
    recordingId,
    status: row.status,
    seller: row.resolved_username,
    pid: row.process_pid,
    watchUrl: row.watch_url,
  }),
);

const r = await startLiveViewerPresence(env, {
  recordingId,
  watchUrl: row.watch_url,
  username:
    row.resolved_username ||
    usernameFromWatchUrl(row.watch_url) ||
    undefined,
  broadcastId: extractBroadcastIdFromUrl(row.watch_url),
});

if (!r.ok) {
  console.error(JSON.stringify(r));
  await sql.end();
  process.exit(1);
}

console.log(
  JSON.stringify({
    ok: true,
    cookieUsername: r.presence.cookieUsername,
    broadcastId: r.presence.broadcastId,
    startedAt: r.presence.startedAt,
  }),
);

const pid = row.process_pid != null ? Number(row.process_pid) : null;
const stop = async () => {
  await stopLiveViewerPresence(recordingId);
  await sql.end({ timeout: 2 });
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());

for (;;) {
  await Bun.sleep(5000);
  if (pid && pid > 1) {
    try {
      process.kill(pid, 0);
    } catch {
      console.log("[attach-live-viewer] ffmpeg gone — stopping presence");
      await stop();
      break;
    }
  }
  const st = await sql<{ status: string }[]>`
    SELECT status FROM live_captures WHERE recording_id = ${recordingId}
  `;
  if (!st[0] || !["recording", "finalizing"].includes(st[0].status)) {
    console.log("[attach-live-viewer] capture status left recording — stop");
    await stop();
    break;
  }
}
