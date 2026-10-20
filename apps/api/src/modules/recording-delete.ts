/**
 * Delete a recording and all derived analysis + storage artifacts.
 * Never touches storage/secrets (IG cookies / credentials).
 */
import { rm, unlink } from "node:fs/promises";
import type { Sql } from "@mezatizle/db";
import type { AppEnv } from "../lib/env.ts";
import { safeJoinStorage } from "../lib/storage.ts";
import { cancelLiveCapture } from "./live_capture.ts";
import { stopLiveViewerPresence } from "./ig_live_playwright.ts";

export type DeleteRecordingResult = {
  recordingId: string;
  deleted: boolean;
  sellerId: string | null;
  filesRemoved: string[];
  error?: string;
};

async function safeRm(path: string, filesRemoved: string[]) {
  try {
    await rm(path, { recursive: true, force: true });
    filesRemoved.push(path);
  } catch {
    /* missing is fine */
  }
}

async function safeUnlink(path: string, filesRemoved: string[]) {
  try {
    await unlink(path);
    filesRemoved.push(path);
  } catch {
    /* missing is fine */
  }
}

/**
 * Cascade delete one recording:
 * sales (+ evidence) → products tied to those sales → recording row
 * (jobs/transcripts/comments/events/metrics/live_captures CASCADE).
 * Then remove MP4 / WAV / frames / product thumbs. Never secrets/.
 */
export async function deleteRecording(
  sql: Sql,
  env: AppEnv,
  recordingId: string,
): Promise<DeleteRecordingResult> {
  const filesRemoved: string[] = [];
  const [rec] = await sql<{ id: string; seller_id: string; storage_path: string }[]>`
    SELECT id, seller_id, storage_path FROM recordings WHERE id = ${recordingId}
  `;
  if (!rec) {
    return {
      recordingId,
      deleted: false,
      sellerId: null,
      filesRemoved,
      error: "not_found",
    };
  }

  try {
    await stopLiveViewerPresence(recordingId);
  } catch {
    /* ignore */
  }
  try {
    await cancelLiveCapture(sql, recordingId);
  } catch {
    /* may already be complete */
  }

  // Product thumbs linked via sales for this recording
  const productRows = await sql<{ id: string; image_path: string | null }[]>`
    SELECT DISTINCT p.id, p.attributes->>'imagePath' AS image_path
    FROM products p
    JOIN sales sa ON sa.product_id = p.id
    WHERE sa.recording_id = ${recordingId}
  `;
  // Also products referenced only in attributes.recordingId (if any)
  const attrProducts = await sql<{ id: string; image_path: string | null }[]>`
    SELECT id, attributes->>'imagePath' AS image_path
    FROM products
    WHERE attributes->>'recordingId' = ${recordingId}
  `;
  const productIds = new Set<string>();
  const imagePaths: string[] = [];
  for (const p of [...productRows, ...attrProducts]) {
    productIds.add(p.id);
    if (p.image_path) imagePaths.push(p.image_path);
  }

  // Explicit sales delete (FK is SET NULL on recording delete)
  await sql`DELETE FROM sale_evidence WHERE sale_id IN (
    SELECT id FROM sales WHERE recording_id = ${recordingId}
  )`;
  await sql`DELETE FROM sales WHERE recording_id = ${recordingId}`;

  if (productIds.size) {
    const ids = [...productIds];
    await sql`DELETE FROM products WHERE id = ANY(${ids}::uuid[])`;
  }

  // Recording row — cascades jobs, transcripts, comments, events, metrics, live_captures
  await sql`DELETE FROM recordings WHERE id = ${recordingId}`;

  // Storage: master, audio, frames dir (never secrets/)
  try {
    const mp4 = safeJoinStorage(env.storageRoot, rec.storage_path);
    await safeUnlink(mp4, filesRemoved);
    await safeUnlink(`${mp4}.part.mp4`, filesRemoved);
  } catch {
    /* bad path — skip */
  }
  try {
    const wav = safeJoinStorage(env.storageRoot, "audio", `${recordingId}.wav`);
    await safeUnlink(wav, filesRemoved);
  } catch {
    /* skip */
  }
  try {
    const frames = safeJoinStorage(env.storageRoot, "frames", recordingId);
    await safeRm(frames, filesRemoved);
  } catch {
    /* skip */
  }
  for (const img of imagePaths) {
    try {
      // imagePath is usually "products/<uuid>.jpg"
      const abs = safeJoinStorage(env.storageRoot, ...img.split("/").filter(Boolean));
      await safeUnlink(abs, filesRemoved);
    } catch {
      try {
        const abs = safeJoinStorage(env.storageRoot, "products", img.split("/").pop()!);
        await safeUnlink(abs, filesRemoved);
      } catch {
        /* skip */
      }
    }
  }

  return {
    recordingId,
    deleted: true,
    sellerId: rec.seller_id,
    filesRemoved,
  };
}

export async function deleteOrphanSellers(sql: Sql): Promise<string[]> {
  const orphans = await sql<{ id: string; instagram_username: string }[]>`
    SELECT s.id, s.instagram_username
    FROM sellers s
    WHERE NOT EXISTS (SELECT 1 FROM recordings r WHERE r.seller_id = s.id)
      AND NOT EXISTS (SELECT 1 FROM sales sa WHERE sa.seller_id = s.id)
      AND NOT EXISTS (SELECT 1 FROM products p WHERE p.seller_id = s.id)
  `;
  const removed: string[] = [];
  for (const s of orphans) {
    await sql`DELETE FROM sellers WHERE id = ${s.id}`;
    removed.push(s.instagram_username);
  }
  return removed;
}

export async function bulkDeleteRecordings(
  sql: Sql,
  env: AppEnv,
  ids: string[],
): Promise<{
  deleted: DeleteRecordingResult[];
  orphanSellersRemoved: string[];
}> {
  const unique = [...new Set(ids.map((x) => String(x).trim()).filter(Boolean))];
  const deleted: DeleteRecordingResult[] = [];
  for (const id of unique) {
    deleted.push(await deleteRecording(sql, env, id));
  }
  const orphanSellersRemoved = await deleteOrphanSellers(sql);
  return { deleted, orphanSellersRemoved };
}
