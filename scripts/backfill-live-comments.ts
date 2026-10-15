/**
 * Try to recover IG live comments for completed keepers via the same
 * logged-in get_comment endpoint used during recording.
 *
 * Ended broadcasts usually return "media has been deleted" — document that
 * honestly; do not invent buyers.
 *
 * Usage: bun run scripts/backfill-live-comments.ts
 */
import { createSql } from "@mezatizle/db";
import { loadEnv } from "../apps/api/src/lib/env.ts";
import {
  extractBroadcastIdFromUrl,
  fetchLiveCommentsForBroadcast,
} from "../apps/api/src/modules/ig_live_playwright.ts";
import { persistLiveComments } from "../apps/api/src/modules/live_capture.ts";
import {
  segmentAuctionFromSignals,
  reconcileSales,
} from "../apps/api/src/modules/auction_pipeline.ts";

const TARGETS = [
  {
    id: "6c7e9508-5162-4d9f-955d-d12c6fa195bc",
    username: "yesilkoyantika_",
    broadcastId: "18093629261179067",
  },
  {
    id: "99b0f63c-94d7-4a63-a746-257bb5589a8e",
    username: "yesilkoyantika_",
    broadcastId: null as string | null, // may be missing from URL
  },
];

const env = loadEnv();
const sql = createSql(env.databaseUrl);

type Row = {
  recording_id: string;
  watch_url: string;
  resolved_username: string | null;
  input_raw: string | null;
};

const results: Array<Record<string, unknown>> = [];

for (const t of TARGETS) {
  const [cap] = await sql<Row[]>`
    SELECT recording_id, watch_url, resolved_username, input_raw
    FROM live_captures WHERE recording_id = ${t.id}
  `;
  if (!cap) {
    results.push({ id: t.id, error: "no_live_capture" });
    continue;
  }
  const bid =
    t.broadcastId ||
    extractBroadcastIdFromUrl(cap.watch_url) ||
    extractBroadcastIdFromUrl(cap.input_raw || "") ||
    null;
  const username =
    t.username || cap.resolved_username || "yesilkoyantika_";

  console.log(`\n=== ${t.id} bid=${bid ?? "MISSING"} @${username} ===`);
  if (!bid) {
    results.push({
      id: t.id,
      backfill: "skipped",
      reason: "no_broadcast_id_on_capture",
      note: "Username-only watch URL — comments cannot be keyed to a past live.",
    });
    continue;
  }

  const fetched = await fetchLiveCommentsForBroadcast(env, {
    broadcastId: bid,
    username,
    lastCommentTs: 0,
  });
  console.log("fetch", JSON.stringify({
    ok: fetched.ok,
    httpStatus: fetched.httpStatus,
    hits: fetched.hits.length,
    detail: fetched.detail,
    rawSnippet: fetched.rawSnippet,
  }));

  let inserted = 0;
  if (fetched.hits.length) {
    inserted = await persistLiveComments(sql, t.id, fetched.hits);
    console.log("inserted", inserted);
    // Re-run segment + reconcile with recovered comments
    const seg = await segmentAuctionFromSignals(sql, t.id);
    const rec = await reconcileSales(sql, t.id, env.storageRoot);
    const [counts] = await sql`
      SELECT
        (SELECT COUNT(*)::int FROM observed_comments WHERE recording_id = ${t.id}) AS comments,
        (SELECT COUNT(*)::int FROM sales WHERE recording_id = ${t.id}) AS sales
    `;
    results.push({
      id: t.id,
      broadcastId: bid,
      backfill: "recovered",
      httpStatus: fetched.httpStatus,
      hits: fetched.hits.length,
      inserted,
      segment: seg,
      reconcile: rec,
      counts,
    });
  } else {
    results.push({
      id: t.id,
      broadcastId: bid,
      backfill: "unavailable",
      httpStatus: fetched.httpStatus,
      detail: fetched.detail,
      rawSnippet: fetched.rawSnippet,
      note:
        "Ended IG lives typically delete comment API access. Future recordings poll get_comment while live.",
    });
  }
}

console.log("\n=== SUMMARY ===");
console.log(JSON.stringify(results, null, 2));
await sql.end?.({ timeout: 5 });
process.exit(0);
